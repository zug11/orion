//! Windows account identity for the local assistant connection.
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{LocalFree, HANDLE},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
        TOKEN_USER,
    },
    System::Threading::OpenProcessToken,
};

pub(crate) fn process_user_sid(process: HANDLE) -> io::Result<String> {
    // TokenUser returns a SID pointing into the supplied, aligned buffer.
    // Copy its textual representation before releasing either allocation.
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle::from_raw_handle(token);
        let mut length = 0;
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut length,
        );
        if length < size_of::<TOKEN_USER>() as u32 || length > 4096 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(io::Error::last_os_error());
        }
        let count = (0..184)
            .find(|index| *sid.add(*index) == 0)
            .expect("a Windows SID string is shorter than 184 characters");
        let result = String::from_utf16(std::slice::from_raw_parts(sid, count));
        LocalFree(sid.cast());
        result.map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
}
