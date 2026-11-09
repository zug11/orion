//! Same-account, local-only Windows counterpart of the Unix workflow socket.
use crate::{
    assistant_protocol::{self, BridgeDescriptor},
    windows_ipc_identity::process_user_sid,
};
use std::{
    fs::OpenOptions,
    io::{self, Write},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    ptr,
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_SUCCESS},
    Security::{
        Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SetSecurityInfo, SDDL_REVISION_1,
            SE_FILE_OBJECT,
        },
        GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::WRITE_DAC,
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

    fn protect_file(&self, path: &Path) -> io::Result<()> {
        let file = OpenOptions::new().access_mode(WRITE_DAC).open(path)?;
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = ptr::null_mut();
        // SAFETY: The descriptor is live until SetSecurityInfo copies the ACL.
        unsafe {
            if GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) == 0
                || present == 0
                || dacl.is_null()
            {
                return Err(io::Error::last_os_error());
            }
            let result = SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            );
            if result != ERROR_SUCCESS {
                return Err(io::Error::from_raw_os_error(result as i32));
            }
        }
        Ok(())
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
    let mut security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: acl.0,
        bInheritHandle: 0,
    };
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
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    PrivateAcl::for_account(sid)?.protect_file(temporary.path())?;
    serde_json::to_writer(temporary.as_file_mut(), descriptor)?;
    temporary.as_file_mut().flush()?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(directory.join(assistant_protocol::BRIDGE_DESCRIPTOR))
        .map_err(|error| error.error)?;
    Ok(())
}
