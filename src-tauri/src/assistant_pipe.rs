//! Same-account, local-only Windows counterpart of the Unix workflow socket.
use crate::{
    assistant_protocol::{self, BridgeDescriptor},
    windows_ipc_identity::process_user_sid,
};
use std::{
    fs::{self, File},
    io::{self, Write},
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::Path,
    ptr,
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::{LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    },
    System::Threading::GetCurrentProcess,
};

struct PrivateAcl(PSECURITY_DESCRIPTOR);

impl PrivateAcl {
    fn for_account(sid: &str) -> io::Result<Self> {
        // The protected DACL grants access only to the account SID, including
        // when Orion was started with an elevated token.
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain([0])
            .collect();
        let mut descriptor = ptr::null_mut();
        // SAFETY: SDDL is null-terminated. The API allocates the descriptor.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }

    fn create_file(&self, path: &Path) -> io::Result<File> {
        let path: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        // SAFETY: The path and ACL remain live for the call. CREATE_NEW never
        // follows an existing file, and the successful handle belongs to File.
        unsafe {
            let handle = CreateFileW(
                path.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &self.attributes(),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            Ok(File::from_raw_handle(handle))
        }
    }
}

impl Drop for PrivateAcl {
    fn drop(&mut self) {
        // SAFETY: ConvertStringSecurityDescriptorToSecurityDescriptorW uses LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

pub(crate) fn current_account() -> io::Result<String> {
    // SAFETY: GetCurrentProcess returns a valid process pseudohandle.
    process_user_sid(unsafe { GetCurrentProcess() })
}

pub(crate) fn listen(name: &str, sid: &str, first: bool) -> io::Result<NamedPipeServer> {
    let acl = PrivateAcl::for_account(sid)?;
    let mut security = acl.attributes();
    // SAFETY: Windows consumes the descriptor synchronously when creating the pipe.
    unsafe {
        ServerOptions::new()
            .reject_remote_clients(true)
            .first_pipe_instance(first)
            .max_instances(2)
            .create_with_security_attributes_raw(
                name,
                (&mut security as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
}

pub(crate) fn publish(
    directory: &Path,
    descriptor: &BridgeDescriptor,
    sid: &str,
) -> io::Result<()> {
    let directory = fs::canonicalize(directory)?;
    let acl = PrivateAcl::for_account(sid)?;
    let mut temporary =
        tempfile::Builder::new().make_in(&directory, |path| acl.create_file(path))?;
    serde_json::to_writer(temporary.as_file_mut(), descriptor)?;
    temporary.as_file_mut().flush()?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(directory.join(assistant_protocol::BRIDGE_DESCRIPTOR))
        .map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_and_replaces_the_windows_descriptor() {
        let directory = tempfile::tempdir().unwrap();
        let sid = current_account().unwrap();
        let mut descriptor = BridgeDescriptor {
            version: assistant_protocol::BRIDGE_VERSION,
            socket_path: format!(
                "{}{}",
                assistant_protocol::WINDOWS_PIPE_PREFIX,
                "a".repeat(64)
            ),
            vault_path: directory.path().join("vault.json").to_string_lossy().into(),
            token: "b".repeat(64),
        };
        for token in ["c".repeat(64), "d".repeat(64)] {
            descriptor.token = token.clone();
            publish(directory.path(), &descriptor, &sid).unwrap();
            let path = directory.path().join(assistant_protocol::BRIDGE_DESCRIPTOR);
            let saved: BridgeDescriptor = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(saved.token, token);
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
