//! Runtime Dock tile plus reversible Finder custom-icon metadata on this app.
//! Never rewrite a signed resource or accept a target path from the renderer.
//! https://developer.apple.com/documentation/appkit/nsapplication/applicationiconimage
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Default)]
pub struct ThemeIconState(Mutex<Option<(Option<Vec<u8>>, IconStatus)>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconStatus {
    applied: bool,
    finder: &'static str,
}

fn decode_icon(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > 1_500_000 {
        return Err("The icon exceeds its size limit.".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid icon encoding.")?;
    // The renderer emits one fixed-size PNG, never a path or arbitrary URL.
    // Check dimensions before handing bytes to an image decoder.
    if bytes.len() < 33
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[8..16] != b"\0\0\0\rIHDR"
        || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != 512
        || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != 512
        || bytes[24] != 8
        || ![2, 6].contains(&bytes[25])
    {
        return Err("The icon must be a 512-pixel PNG.".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn set_theme_icon(
    app: AppHandle,
    window: WebviewWindow,
    png: Option<String>,
) -> Result<IconStatus, String> {
    let bytes = png.as_deref().map(decode_icon).transpose()?;
    #[cfg(target_os = "macos")]
    {
        use objc2::{AllocAnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
        use objc2_foundation::{NSBundle, NSData};
        let (send, receive) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = (|| {
                // A delayed background window must not replace a newer choice
                // in the window the user is working in.
                if !crate::desktop_windows::preferred_window(&handle)
                    .is_some_and(|preferred| preferred.label() == window.label())
                {
                    return Ok(IconStatus {
                        applied: false,
                        finder: "unavailable",
                    });
                }
                let state = handle.state::<ThemeIconState>();
                let mut previous = state.0.lock().map_err(|_| "Icon state is unavailable.")?;
                if let Some((prior, status)) = previous.as_ref() {
                    if prior == &bytes && ["updated", "restored"].contains(&status.finder) {
                        return Ok(status.clone());
                    }
                }
                let mtm = MainThreadMarker::new().ok_or("Icon updates require the main thread.")?;
                let image = bytes
                    .as_ref()
                    .map(|bytes| {
                        NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))
                            .ok_or("The icon image could not be decoded.")
                    })
                    .transpose()?;
                let application = NSApplication::sharedApplication(mtm);
                let bundle = NSBundle::mainBundle();
                let path = bundle.bundlePath();
                // Plain `tauri dev` has no app bundle; mounted DMGs and app
                // translocation may be read-only. Never elevate or target a
                // different installation in those cases.
                let finder = if path.to_string().ends_with(".app")
                    && bundle
                        .bundleIdentifier()
                        .is_some_and(|id| id.to_string() == handle.config().identifier)
                {
                    if NSWorkspace::sharedWorkspace().setIcon_forFile_options(
                        image.as_deref(),
                        &path,
                        NSWorkspaceIconCreationOptions::empty(),
                    ) {
                        if image.is_some() {
                            "updated"
                        } else {
                            "restored"
                        }
                    } else {
                        "read-only"
                    }
                } else {
                    "unavailable"
                };
                // AppKit retains the image. Nil restores the packaged icon.
                unsafe {
                    application.setApplicationIconImage(image.as_deref());
                }
                let status = IconStatus {
                    applied: true,
                    finder,
                };
                *previous = Some((bytes, status.clone()));
                Ok(status)
            })();
            let _ = send.send(result);
        })
        .map_err(|_| "Orion could not reach the Dock.".to_string())?;
        receive
            .await
            .map_err(|_| "The application closed before its icon updated.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, bytes);
        Ok(IconStatus {
            applied: false,
            finder: "unavailable",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_fixed_size_pngs_reach_appkit() {
        assert!(decode_icon("file:///tmp/icon.png").is_err());
        assert!(decode_icon(&"A".repeat(1_500_001)).is_err());
        assert!(decode_icon(&STANDARD.encode(b"not an image")).is_err());
        let mut header =
            b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\x02\0\0\0\x02\0\x08\x06\0\0\0\0\0\0\0".to_vec();
        assert!(decode_icon(&STANDARD.encode(&header)).is_ok());
        header[16] = 0x7f;
        assert!(decode_icon(&STANDARD.encode(&header)).is_err());
    }
}
