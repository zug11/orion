//! User-requested local narration export. Destinations come only from Save As.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path, process::Command, time::Duration};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;
use zeroize::Zeroizing;

const MAX_AUDIO_BYTES: usize = 128 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 80_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NarrationExportRequest {
    request_id: String,
    file_name: String,
    wav_base64: Option<String>,
    system_text: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct NarrationExportResult {
    path: String,
    cancelled: bool,
}

fn validate(request: &NarrationExportRequest) -> Result<(), String> {
    if !request.request_id.starts_with("narration-export:")
        || !crate::media_jobs::valid_id(&request.request_id)
        || request.file_name.trim().is_empty()
        || request.file_name.chars().count() > 240
    {
        return Err("The narration export request is invalid.".into());
    }
    match (&request.wav_base64, &request.system_text) {
        (Some(audio), None)
            if !audio.is_empty() && audio.len() <= MAX_AUDIO_BYTES.div_ceil(3) * 4 =>
        {
            Ok(())
        }
        (None, Some(text))
            if !text.trim().is_empty()
                && text.encode_utf16().count() <= MAX_TEXT_CHARS
                && !text.chars().any(|character| {
                    character.is_control() && !matches!(character, '\n' | '\r' | '\t')
                }) =>
        {
            Ok(())
        }
        _ => Err("The narration is empty, invalid or too large to download as one file.".into()),
    }
}

/// Accept only our canonical 24 kHz mono, 16-bit PCM container, never arbitrary
/// renderer-provided bytes disguised as a downloadable audio file.
fn validate_wav(bytes: &[u8]) -> Result<(), String> {
    let invalid = || "The narration returned an invalid WAV file.".to_string();
    if bytes.len() <= 44
        || bytes.len() > MAX_AUDIO_BYTES
        || &bytes[0..4] != b"RIFF"
        || &bytes[8..16] != b"WAVEfmt "
        || &bytes[36..40] != b"data"
    {
        return Err(invalid());
    }
    let u32_at = |index| u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap());
    let u16_at = |index| u16::from_le_bytes(bytes[index..index + 2].try_into().unwrap());
    if u32_at(4) as usize != bytes.len() - 8
        || u32_at(16) != 16
        || u16_at(20) != 1
        || u16_at(22) != 1
        || u32_at(24) != 24_000
        || u32_at(28) != 48_000
        || u16_at(32) != 2
        || u16_at(34) != 16
        || u32_at(40) as usize != bytes.len() - 44
        || !(bytes.len() - 44).is_multiple_of(2)
    {
        return Err(invalid());
    }
    Ok(())
}

fn persist_audio(path: &Path, audio: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or("Choose an existing folder for the narration.")?;
    let mut temporary = NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    temporary
        .write_all(audio)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Orion could not write the narration: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Orion could not save the narration: {}", error.error))?;
    crate::sync_directory(directory)
}

fn system_audio(text: &str, control: &crate::media_jobs::Control) -> Result<Vec<u8>, String> {
    if !cfg!(target_os = "macos") {
        return Err("System-voice downloads require the Mac app.".into());
    }
    let mut script = NamedTempFile::new().map_err(|error| error.to_string())?;
    script
        .write_all(text.as_bytes())
        .and_then(|_| script.flush())
        .map_err(|error| error.to_string())?;
    let audio = tempfile::Builder::new()
        .suffix(".aiff")
        .tempfile()
        .map_err(|error| error.to_string())?;
    let mut command = Command::new("/usr/bin/say");
    command
        .args(["--file-format=AIFF", "-r", "192", "-f"])
        .arg(script.path())
        .arg("-o")
        .arg(audio.path());
    crate::media_jobs::limit_download_file_size(&mut command, MAX_AUDIO_BYTES as u64);
    let output = control.run(&mut command, Duration::from_secs(300))?;
    control.check()?;
    if !output.status.success() {
        return Err("macOS could not save this narration. Try a shorter note or check that a system voice is installed.".into());
    }
    let length = fs::metadata(audio.path())
        .map_err(|error| error.to_string())?
        .len();
    if !(12..=MAX_AUDIO_BYTES as u64).contains(&length) {
        return Err("The system narration was empty or too large.".into());
    }
    let bytes = fs::read(audio.path()).map_err(|error| error.to_string())?;
    if &bytes[..4] != b"FORM" || (&bytes[8..12] != b"AIFF" && &bytes[8..12] != b"AIFC") {
        return Err("macOS returned an invalid narration file.".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub(crate) async fn export_narration(
    app: AppHandle,
    window: WebviewWindow,
    jobs: State<'_, crate::media_jobs::MediaJobs>,
    request: NarrationExportRequest,
) -> Result<NarrationExportResult, String> {
    validate(&request)?;
    let job = jobs.begin_picker(window.label(), &request.request_id)?;
    let extension = if request.system_text.is_some() {
        "aiff"
    } else {
        "wav"
    };
    let stem = Path::new(&request.file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Orion narration");
    let selected = app
        .dialog()
        .file()
        .set_title("Download narration")
        .set_file_name(format!("{}.{}", crate::safe_file_stem(stem), extension))
        .add_filter("Narration audio", &[extension])
        .blocking_save_file();
    job.control.check()?;
    let Some(selected) = selected else {
        return Ok(NarrationExportResult {
            path: String::new(),
            cancelled: true,
        });
    };
    let mut path = crate::selected_export_path(selected)?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case(extension))
    {
        path.set_extension(extension);
    }
    let display_path = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        job.control.check()?;
        let audio = Zeroizing::new(match request.system_text {
            Some(text) => system_audio(&text, &job.control)?,
            None => {
                let bytes = STANDARD
                    .decode(request.wav_base64.as_deref().unwrap_or_default())
                    .map_err(|_| "The narration audio is invalid.")?;
                validate_wav(&bytes)?;
                bytes
            }
        });
        job.control.check()?;
        persist_audio(&path, &audio)
    })
    .await
    .map_err(|error| format!("The narration export could not finish: {error}"))??;
    Ok(NarrationExportResult {
        path: display_path,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_scope_text_and_exclusive_audio_input() {
        let mut request = NarrationExportRequest {
            request_id: "narration-export:test1".into(),
            file_name: "Note.aiff".into(),
            wav_base64: None,
            system_text: Some("A local narration.".into()),
        };
        assert!(validate(&request).is_ok());
        request.wav_base64 = Some("AAAA".into());
        assert!(validate(&request).is_err());
        request.wav_base64 = None;
        request.system_text = Some("a".repeat(MAX_TEXT_CHARS + 1));
        assert!(validate(&request).is_err());
        request.system_text = Some("invalid\0text".into());
        assert!(validate(&request).is_err());
        request.system_text = Some("words".into());
        request.request_id = "other-request".into();
        assert!(validate(&request).is_err());
    }
    #[test]
    fn rejects_truncated_and_disguised_audio() {
        assert!(validate_wav(b"RIFF").is_err());
        assert!(validate_wav(&[0; 100]).is_err());
        let mut bytes = vec![0_u8; 46];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&38_u32.to_le_bytes());
        bytes[8..16].copy_from_slice(b"WAVEfmt ");
        bytes[16..20].copy_from_slice(&16_u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&[1, 0, 1, 0]);
        bytes[24..28].copy_from_slice(&24_000_u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&48_000_u32.to_le_bytes());
        bytes[32..36].copy_from_slice(&[2, 0, 16, 0]);
        bytes[36..40].copy_from_slice(b"data");
        bytes[40..44].copy_from_slice(&2_u32.to_le_bytes());
        assert!(validate_wav(&bytes).is_ok());
        bytes[40] = 4;
        assert!(validate_wav(&bytes).is_err());
    }
    #[test]
    fn replaces_download_atomically_without_touching_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.wav");
        fs::write(&path, b"previous").unwrap();
        fs::write(directory.path().join("other"), b"keep").unwrap();
        persist_audio(&path, b"new audio").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new audio");
        assert_eq!(fs::read(directory.path().join("other")).unwrap(), b"keep");
    }
    #[test]
    #[ignore = "requires an installed macOS system voice"]
    fn generates_real_system_voice_audio() {
        let audio = system_audio(
            "Orion can download this narration.",
            &crate::media_jobs::Control::default(),
        )
        .unwrap();
        assert_eq!(&audio[..4], b"FORM");
        assert!(audio.len() > 1_000);
    }
}
