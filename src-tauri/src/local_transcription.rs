//! Offline media transcription, persistent dictation workers, and local speech alignment.
//! Request ownership and cancellable subprocess execution remain in `media_jobs`.

use crate::{is_executable_file, media_jobs, speech_timing};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tempfile::TempDir;
use zeroize::Zeroizing;

const MAX_MEDIA_FILES: usize = 8;
const MAX_MEDIA_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_VOICE_MEMO_BYTES: usize = 64 * 1024 * 1024;
const MAX_VOICE_MEMO_BASE64_BYTES: usize = MAX_VOICE_MEMO_BYTES.div_ceil(3) * 4;
const BUNDLED_WHISPER_NAME: &str = "orion-whisper";
const BUNDLED_WHISPER_MODEL_NAME: &str = "ggml-model.bin";
const BUNDLED_YT_DLP_NAME: &str = "yt-dlp";
const BUNDLED_DENO_NAME: &str = "deno";
const MIN_BUNDLED_MODEL_BYTES: u64 = 400 * 1024 * 1024;
const MEDIA_EXTENSIONS: &[&str] = &[
    "flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "ogg", "wav", "webm",
];

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WhisperConfig {
    #[serde(default)]
    pub(super) language: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct VoiceMemoRequest {
    file_name: String,
    mime_type: String,
    base64_data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct YouTubeTranscriptionRequest {
    url: String,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Clone)]
pub(super) struct TranscriptionRuntime {
    whisper: PathBuf,
    model: PathBuf,
    yt_dlp: PathBuf,
    deno: PathBuf,
}

struct VoiceMemoWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_request_id: u64,
}

impl Drop for VoiceMemoWorker {
    fn drop(&mut self) {
        let _ = self.stdin.write_all(b"{\"quit\":true}\n");
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Default)]
pub(super) struct VoiceMemoWorkers(Arc<Mutex<HashMap<String, VoiceMemoWorker>>>);

#[derive(Serialize)]
struct VoiceMemoWorkerRequest<'a> {
    id: u64,
    input: &'a str,
}

#[derive(Deserialize)]
struct VoiceMemoWorkerResponse {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    ready: Option<bool>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TranscribedMedia {
    title: String,
    file_name: String,
    mime_type: String,
    byte_size: u64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaTranscriptionFailure {
    file_name: String,
    error: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaTranscriptionBatch {
    transcripts: Vec<TranscribedMedia>,
    failures: Vec<MediaTranscriptionFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TranscriptionSetupStatus {
    whisper_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    whisper_version: Option<String>,
    whisper_model: String,
    yt_dlp_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    yt_dlp_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deno_version: Option<String>,
    message: String,
}

/// Timing failure must not discard already-generated speech or retry a paid call.
pub(super) async fn align_generated_speech(
    app: &AppHandle,
    job: media_jobs::Job,
    text: &str,
    bytes: &[u8],
) -> Option<Vec<speech_timing::SpeechWordTiming>> {
    let runtime = bundled_transcription_runtime(app).ok()?;
    validate_whisper_runtime(&runtime).ok()?;
    let audio = bytes.to_vec();
    let text = text.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        job.control.check().ok()?;
        // tempfile creates a private mode-0600 file; Drop removes it on every path.
        let mut file = tempfile::Builder::new()
            .prefix("orion-speech-")
            .suffix(".mp3")
            .tempfile()
            .ok()?;
        file.write_all(&audio).ok()?;
        file.flush().ok()?;
        let run = |cpu: bool| {
            let mut command = Command::new(&runtime.whisper);
            command
                .arg("--align")
                .arg("--model")
                .arg(&runtime.model)
                .arg("--input")
                .arg(file.path());
            if cpu {
                command.arg("--cpu");
            }
            job.control.run(&mut command, Duration::from_secs(120)).ok()
        };
        let mut output = run(false)?;
        if !output.status.success()
            && String::from_utf8_lossy(&output.stderr).contains("ggml_metal_buffer_init: error")
        {
            output = run(true)?;
        }
        job.control.check().ok()?;
        if !output.status.success() {
            return None;
        }
        speech_timing::from_acoustic_json(&text, &output.stdout)
    })
    .await
    .ok()
    .flatten()
}

fn selected_local_path(path: FilePath) -> Result<PathBuf, String> {
    match path {
        FilePath::Path(path) => Ok(path),
        FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "The selected media source is not a local file.".to_string()),
    }
}

fn normalize_transcription_language(config: WhisperConfig) -> Result<Option<String>, String> {
    let language = config
        .language
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "auto");
    if language.as_ref().is_some_and(|value| {
        value.len() > 32
            || value
                .chars()
                .any(|character| !(character.is_ascii_alphanumeric() || character == '-'))
    }) {
        return Err("Use a short language code such as en, fr, or ja.".to_string());
    }
    Ok(language)
}

pub(super) fn bundled_transcription_runtime(
    app: &AppHandle,
) -> Result<TranscriptionRuntime, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Orion could not locate its app bundle: {error}"))?;
    let executable_directory = executable
        .parent()
        .ok_or_else(|| "Orion could not locate its bundled tools.".to_string())?;
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Orion could not locate its bundled model: {error}"))?;

    Ok(TranscriptionRuntime {
        whisper: executable_directory.join(BUNDLED_WHISPER_NAME),
        model: resource_directory
            .join("models")
            .join(BUNDLED_WHISPER_MODEL_NAME),
        yt_dlp: executable_directory.join(BUNDLED_YT_DLP_NAME),
        deno: executable_directory.join(BUNDLED_DENO_NAME),
    })
}

fn validate_whisper_runtime(runtime: &TranscriptionRuntime) -> Result<(), String> {
    if !is_executable_file(&runtime.whisper) {
        return Err(
            "Orion's bundled Whisper engine is missing or damaged. Reinstall Orion.".to_string(),
        );
    }
    let model = fs::metadata(&runtime.model)
        .map_err(|_| "Orion's bundled Whisper model is missing. Reinstall Orion.".to_string())?;
    if !model.is_file() || model.len() < MIN_BUNDLED_MODEL_BYTES {
        return Err(
            "Orion's bundled Whisper model is incomplete or damaged. Reinstall Orion.".to_string(),
        );
    }
    Ok(())
}

fn bundled_whisper_model_label(runtime: &TranscriptionRuntime) -> String {
    match fs::metadata(&runtime.model).map(|metadata| metadata.len()) {
        Ok(bytes) if bytes >= 1_000_000_000 => "Whisper medium · multilingual".to_string(),
        _ => "Whisper small · multilingual".to_string(),
    }
}

fn valid_voice_memo_session_id(session_id: &str) -> bool {
    let length = session_id.len();
    (8..=160).contains(&length)
        && session_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
}

fn launch_voice_memo_worker(
    runtime: &TranscriptionRuntime,
    language: Option<&str>,
    use_cpu: bool,
) -> Result<VoiceMemoWorker, String> {
    let mut command = Command::new(&runtime.whisper);
    command
        .arg("--server")
        .arg("--model")
        .arg(&runtime.model)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if use_cpu {
        command.arg("--cpu");
    }
    if let Some(language) = language {
        command.arg("--language").arg(language);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Orion could not start its persistent Whisper worker: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "The persistent Whisper worker has no input channel.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The persistent Whisper worker has no output channel.".to_string())?;
    let mut worker = VoiceMemoWorker {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_request_id: 1,
    };
    let mut ready_line = String::new();
    worker
        .stdout
        .read_line(&mut ready_line)
        .map_err(|error| format!("The persistent Whisper worker could not initialize: {error}"))?;
    let response: VoiceMemoWorkerResponse =
        serde_json::from_str(ready_line.trim()).map_err(|_| {
            "The persistent Whisper worker returned an invalid startup response.".to_string()
        })?;
    if response.ready != Some(true) {
        return Err(response.error.unwrap_or_else(|| {
            "The persistent Whisper worker stopped while loading its model.".to_string()
        }));
    }
    Ok(worker)
}

fn start_voice_memo_worker(
    runtime: &TranscriptionRuntime,
    language: Option<String>,
) -> Result<VoiceMemoWorker, String> {
    validate_whisper_runtime(runtime)?;
    match launch_voice_memo_worker(runtime, language.as_deref(), false) {
        Ok(worker) => Ok(worker),
        Err(gpu_error) => launch_voice_memo_worker(runtime, language.as_deref(), true).map_err(
            |cpu_error| {
                format!(
                    "The persistent Whisper worker could not load on GPU ({gpu_error}) or CPU ({cpu_error})."
                )
            },
        ),
    }
}

fn transcribe_voice_memo_with_worker(
    workers: &VoiceMemoWorkers,
    session_id: &str,
    media_path: &Path,
) -> Result<String, String> {
    let input = media_path
        .to_str()
        .ok_or_else(|| "The voice memo temporary path is not valid Unicode.".to_string())?;
    let mut sessions = workers
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let worker = sessions
        .get_mut(session_id)
        .ok_or_else(|| "The persistent dictation session is no longer active.".to_string())?;
    let request_id = worker.next_request_id;
    worker.next_request_id = worker.next_request_id.saturating_add(1);
    let encoded = serde_json::to_vec(&VoiceMemoWorkerRequest {
        id: request_id,
        input,
    })
    .map_err(|error| format!("Orion could not prepare the transcription request: {error}"))?;
    worker
        .stdin
        .write_all(&encoded)
        .and_then(|_| worker.stdin.write_all(b"\n"))
        .and_then(|_| worker.stdin.flush())
        .map_err(|error| {
            format!("The persistent Whisper worker stopped accepting audio: {error}")
        })?;

    let mut response_line = String::new();
    worker
        .stdout
        .read_line(&mut response_line)
        .map_err(|error| format!("The persistent Whisper worker stopped unexpectedly: {error}"))?;
    if response_line.is_empty() {
        return Err("The persistent Whisper worker stopped unexpectedly.".to_string());
    }
    let response: VoiceMemoWorkerResponse = serde_json::from_str(response_line.trim())
        .map_err(|_| "The persistent Whisper worker returned invalid text.".to_string())?;
    if response.id != Some(request_id) {
        return Err("The persistent Whisper worker returned an out-of-order response.".to_string());
    }
    if let Some(error) = response.error.filter(|error| !error.trim().is_empty()) {
        return Err(error.chars().take(900).collect());
    }
    Ok(response.text.unwrap_or_default().trim().to_string())
}

fn validate_youtube_runtime(runtime: &TranscriptionRuntime) -> Result<(), String> {
    if !is_executable_file(&runtime.yt_dlp) {
        return Err("Orion's bundled yt-dlp is missing or damaged. Reinstall Orion.".to_string());
    }
    if !is_executable_file(&runtime.deno) {
        return Err(
            "Orion's bundled YouTube JavaScript runtime is missing or damaged. Reinstall Orion."
                .to_string(),
        );
    }
    Ok(())
}

fn normalize_youtube_url(value: &str) -> Result<String, String> {
    let url =
        Url::parse(value.trim()).map_err(|_| "Enter a valid YouTube video URL.".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Use a standard https YouTube video URL.".to_string());
    }
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "youtube.com"
            | "www.youtube.com"
            | "m.youtube.com"
            | "music.youtube.com"
            | "youtu.be"
            | "www.youtu.be"
    ) {
        return Err("Only YouTube and youtu.be links are supported.".to_string());
    }
    if url.path() == "/" || url.path().is_empty() {
        return Err("Paste a link to a specific YouTube video.".to_string());
    }
    Ok(url.to_string())
}

pub(super) fn media_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| MEDIA_EXTENSIONS.contains(&extension.as_str()))
}

fn media_mime_type(path: &Path) -> &'static str {
    match media_extension(path).as_deref() {
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        Some("mp3" | "mpeg" | "mpga") => "audio/mpeg",
        Some("mp4") => "video/mp4",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

fn media_title(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Media transcript")
        .replace(['_', '-'], " ");
    let title = stem.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        "Media transcript".to_string()
    } else {
        title
    }
}

fn decode_voice_memo(
    request: VoiceMemoRequest,
) -> Result<(String, String, Zeroizing<Vec<u8>>), String> {
    let VoiceMemoRequest {
        file_name,
        mime_type,
        base64_data,
    } = request;
    let normalized_file_name = file_name.trim();
    if normalized_file_name.is_empty()
        || normalized_file_name.chars().count() > 255
        || normalized_file_name.chars().any(char::is_control)
        || normalized_file_name.contains(['/', '\\'])
        || Path::new(normalized_file_name)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("m4a"))
            .unwrap_or(true)
    {
        return Err("That voice memo has an invalid M4A file name.".to_string());
    }
    let normalized_mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        normalized_mime_type.as_str(),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a"
    ) {
        return Err("Orion accepts voice memos as M4A audio.".to_string());
    }
    let encoded = Zeroizing::new(base64_data);
    if encoded.is_empty() {
        return Err("The voice memo is empty.".to_string());
    }
    if encoded.len() > MAX_VOICE_MEMO_BASE64_BYTES {
        return Err("Voice memos must be 64 MB or smaller.".to_string());
    }
    let bytes = Zeroizing::new(
        BASE64_STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| "The voice memo data is not valid base64.".to_string())?,
    );
    if bytes.is_empty() {
        return Err("The voice memo is empty.".to_string());
    }
    if bytes.len() > MAX_VOICE_MEMO_BYTES {
        return Err("Voice memos must be 64 MB or smaller.".to_string());
    }
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return Err("The voice memo contents are not valid M4A audio.".to_string());
    }
    Ok((
        normalized_file_name.to_string(),
        normalized_mime_type,
        bytes,
    ))
}

async fn transcribe_path(
    runtime: &TranscriptionRuntime,
    config: &WhisperConfig,
    path: &Path,
    title_override: Option<String>,
    source_url: Option<String>,
) -> Result<TranscribedMedia, String> {
    transcribe_path_controlled(
        runtime,
        config,
        path,
        title_override,
        source_url,
        &media_jobs::Control::default(),
    )
    .await
}

pub(super) async fn transcribe_path_controlled(
    runtime: &TranscriptionRuntime,
    config: &WhisperConfig,
    path: &Path,
    title_override: Option<String>,
    source_url: Option<String>,
    control: &media_jobs::Control,
) -> Result<TranscribedMedia, String> {
    control.check()?;
    let extension = media_extension(path)
        .ok_or_else(|| "Choose FLAC, M4A, MP3, MP4, MPEG, OGG, WAV, or WebM media.".to_string())?;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Orion could not inspect this media file: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected media source is not a file.".to_string());
    }
    if metadata.len() == 0 {
        return Err("The selected media file is empty.".to_string());
    }
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err("Media files must be smaller than 2 GB.".to_string());
    }
    validate_whisper_runtime(runtime)?;
    let language = normalize_transcription_language(config.clone())?;
    let whisper = runtime.whisper.clone();
    let model = runtime.model.clone();
    let media = path.to_path_buf();
    let process_control = control.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let run = |use_cpu: bool| {
            let mut command = Command::new(&whisper);
            command
                .arg("--model")
                .arg(&model)
                .arg("--input")
                .arg(&media);
            if use_cpu {
                command.arg("--cpu");
            }
            if let Some(language) = language.as_ref() {
                command.arg("--language").arg(language);
            }
            process_control.run(&mut command, media_jobs::TRANSCRIPTION_TIMEOUT)
        };
        let first = run(false)?;
        let gpu_allocation_failed = !first.status.success()
            && String::from_utf8_lossy(&first.stderr).contains("ggml_metal_buffer_init: error");
        if gpu_allocation_failed {
            run(true)
        } else {
            Ok(first)
        }
    })
    .await
    .map_err(|error| format!("The offline transcription task could not finish: {error}"))??;
    control.check()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("The bundled Whisper engine stopped unexpectedly.")
            .trim();
        return Err(detail.chars().take(900).collect());
    }
    let text = String::from_utf8(output.stdout)
        .map_err(|_| "The bundled Whisper engine returned invalid text.".to_string())?
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("Whisper finished without detecting any speech.".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("media")
        .to_string();

    Ok(TranscribedMedia {
        title: title_override.unwrap_or_else(|| media_title(path)),
        file_name,
        mime_type: media_mime_type(path).to_string(),
        byte_size: metadata.len(),
        text,
        source_url,
        warnings: if extension == "mp4" || extension == "webm" {
            vec![
                "Audio was extracted from the selected video and transcribed entirely on-device."
                    .to_string(),
            ]
        } else {
            Vec::new()
        },
    })
}

fn downloaded_media(directory: &TempDir) -> Result<PathBuf, String> {
    fs::read_dir(directory.path())
        .map_err(|error| format!("Orion could not inspect the temporary download: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && media_extension(path).is_some())
        .max_by_key(|path| {
            fs::metadata(path)
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        })
        .ok_or_else(|| "yt-dlp finished without producing supported media.".to_string())
}

fn yt_dlp_title(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| {
                    value
                        .get("title")?
                        .as_str()
                        .map(str::trim)
                        .map(str::to_string)
                })
                .filter(|title| !title.is_empty())
        })
}

#[tauri::command]
pub(super) async fn transcribe_media_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
    jobs: State<'_, media_jobs::MediaJobs>,
    request_id: String,
    config: WhisperConfig,
) -> Result<MediaTranscriptionBatch, String> {
    let job = jobs.begin_picker(window.label(), &request_id)?;
    normalize_transcription_language(config.clone())?;
    let selected = app
        .dialog()
        .file()
        .set_title("Choose audio or video to transcribe")
        .add_filter("Audio and video", MEDIA_EXTENSIONS)
        .blocking_pick_files();
    let Some(selected) = selected else {
        return Ok(MediaTranscriptionBatch::default());
    };
    if selected.len() > MAX_MEDIA_FILES {
        return Err(format!(
            "Choose no more than {MAX_MEDIA_FILES} media files at a time."
        ));
    }

    // Promote the exact pending control under the registry lock. Cancellation
    // remains durable for the entire dialog lifetime, without blocking Quit on it.
    jobs.promote_picker(&job)?;
    if app.get_webview_window(window.label()).is_none() {
        return Err("The media import window was closed.".into());
    }
    let runtime = bundled_transcription_runtime(&app)?;
    transcribe_media_paths(
        &runtime,
        &config,
        selected.into_iter().map(selected_local_path).collect(),
        &job.control,
    )
    .await
}

async fn transcribe_media_paths(
    runtime: &TranscriptionRuntime,
    config: &WhisperConfig,
    selected: Vec<Result<PathBuf, String>>,
    control: &media_jobs::Control,
) -> Result<MediaTranscriptionBatch, String> {
    let mut result = MediaTranscriptionBatch::default();
    for selected_path in selected {
        control.check_cancelled()?;
        let path = match selected_path {
            Ok(path) => path,
            Err(error) => {
                result.failures.push(MediaTranscriptionFailure {
                    file_name: "Selected media".into(),
                    error,
                });
                continue;
            }
        };
        match transcribe_path_controlled(runtime, config, &path, None, None, control).await {
            Ok(transcript) => result.transcripts.push(transcript),
            Err(error) => {
                control.check_cancelled()?;
                result.failures.push(MediaTranscriptionFailure {
                    file_name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    error,
                });
            }
        }
    }
    control.check_cancelled()?;
    Ok(result)
}

#[tauri::command]
pub(super) fn cancel_media_import(
    window: tauri::WebviewWindow,
    jobs: State<'_, media_jobs::MediaJobs>,
    request_id: String,
) -> Result<(), String> {
    jobs.cancel(window.label(), &request_id)
}

#[tauri::command]
pub(super) async fn start_voice_memo_session(
    app: AppHandle,
    workers: State<'_, VoiceMemoWorkers>,
    session_id: String,
    config: WhisperConfig,
) -> Result<(), String> {
    if !valid_voice_memo_session_id(&session_id) {
        return Err("The dictation session identifier is invalid.".to_string());
    }
    let runtime = bundled_transcription_runtime(&app)?;
    let language = normalize_transcription_language(config)?;
    let shared_workers = workers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let sessions = shared_workers
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if sessions.contains_key(&session_id) {
                return Err("That dictation session is already active.".to_string());
            }
        }
        let worker = start_voice_memo_worker(&runtime, language)?;
        let mut sessions = shared_workers
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sessions.contains_key(&session_id) {
            return Err("That dictation session is already active.".to_string());
        }
        sessions.insert(session_id, worker);
        Ok(())
    })
    .await
    .map_err(|error| format!("The persistent Whisper worker could not start: {error}"))?
}

#[tauri::command]
pub(super) async fn finish_voice_memo_session(
    workers: State<'_, VoiceMemoWorkers>,
    session_id: String,
) -> Result<(), String> {
    if !valid_voice_memo_session_id(&session_id) {
        return Err("The dictation session identifier is invalid.".to_string());
    }
    let shared_workers = workers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let worker = shared_workers
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        drop(worker);
    })
    .await
    .map_err(|error| format!("The persistent Whisper worker could not stop: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(super) async fn transcribe_voice_memo(
    app: AppHandle,
    workers: State<'_, VoiceMemoWorkers>,
    request: VoiceMemoRequest,
    config: WhisperConfig,
    session_id: Option<String>,
) -> Result<TranscribedMedia, String> {
    let (file_name, mime_type, bytes) = decode_voice_memo(request)?;
    let mut temporary = tempfile::Builder::new()
        .prefix("orion-voice-memo-")
        .suffix(".m4a")
        .tempfile()
        .map_err(|error| format!("Orion could not prepare the voice memo: {error}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.flush())
        .map_err(|error| format!("Orion could not prepare the voice memo: {error}"))?;
    let byte_size = bytes.len() as u64;
    if let Some(session_id) = session_id {
        if !valid_voice_memo_session_id(&session_id) {
            return Err("The dictation session identifier is invalid.".to_string());
        }
        let shared_workers = workers.inner().clone();
        let text = tauri::async_runtime::spawn_blocking(move || {
            let path = temporary.path().to_path_buf();
            transcribe_voice_memo_with_worker(&shared_workers, &session_id, &path)
        })
        .await
        .map_err(|error| format!("The dictation segment could not finish: {error}"))??;
        return Ok(TranscribedMedia {
            title: "Voice memo".to_string(),
            file_name,
            mime_type,
            byte_size,
            text,
            source_url: None,
            warnings: Vec::new(),
        });
    }

    let runtime = bundled_transcription_runtime(&app)?;
    let mut transcript = transcribe_path(
        &runtime,
        &config,
        temporary.path(),
        Some("Voice memo".to_string()),
        None,
    )
    .await?;
    transcript.file_name = file_name;
    transcript.mime_type = mime_type;
    transcript.byte_size = byte_size;
    Ok(transcript)
}

#[tauri::command]
pub(super) async fn transcribe_youtube(
    app: AppHandle,
    window: tauri::WebviewWindow,
    jobs: State<'_, media_jobs::MediaJobs>,
    request_id: String,
    request: YouTubeTranscriptionRequest,
) -> Result<TranscribedMedia, String> {
    let job = jobs.begin(window.label(), &request_id)?;
    let runtime = bundled_transcription_runtime(&app)?;
    transcribe_youtube_controlled(&runtime, request, &job.control).await
}

#[cfg(test)]
async fn transcribe_youtube_with_runtime(
    runtime: &TranscriptionRuntime,
    request: YouTubeTranscriptionRequest,
) -> Result<TranscribedMedia, String> {
    transcribe_youtube_controlled(runtime, request, &media_jobs::Control::default()).await
}

async fn transcribe_youtube_controlled(
    runtime: &TranscriptionRuntime,
    request: YouTubeTranscriptionRequest,
    control: &media_jobs::Control,
) -> Result<TranscribedMedia, String> {
    control.check()?;
    validate_whisper_runtime(runtime)?;
    validate_youtube_runtime(runtime)?;
    let config = WhisperConfig {
        language: request.language,
    };
    normalize_transcription_language(config.clone())?;
    let youtube_url = normalize_youtube_url(&request.url)?;
    let temporary = TempDir::new()
        .map_err(|error| format!("Orion could not prepare a temporary download: {error}"))?;
    let output_template = temporary
        .path()
        .join("orion-media.%(ext)s")
        .to_string_lossy()
        .into_owned();
    let executable_for_task = runtime.yt_dlp.clone();
    let deno_runtime = format!("deno:{}", runtime.deno.display());
    let youtube_url_for_task = youtube_url.clone();
    let process_control = control.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(executable_for_task);
        media_jobs::limit_download_file_size(&mut command, MAX_MEDIA_BYTES);
        command.args([
            "--ignore-config",
            "--no-playlist",
            "--no-simulate",
            "--no-progress",
            "--no-part",
            "--socket-timeout",
            "30",
            "--retries",
            "2",
            "--fragment-retries",
            "2",
            "--restrict-filenames",
            "--max-filesize",
            "2G",
            "--js-runtimes",
            &deno_runtime,
            "--format",
            "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
            "--output",
            &output_template,
            "--print",
            "{\"title\":%(title)j}",
            "--",
            &youtube_url_for_task,
        ]);
        process_control.run(&mut command, media_jobs::DOWNLOAD_TIMEOUT)
    })
    .await
    .map_err(|error| format!("The yt-dlp download task could not finish: {error}"))??;
    if !output.status.success() {
        let detail: String = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(900)
            .collect();
        return Err(if detail.is_empty() {
            format!("yt-dlp stopped with status {}.", output.status)
        } else {
            format!("yt-dlp could not download that video: {detail}")
        });
    }

    let path = downloaded_media(&temporary)?;
    let title = yt_dlp_title(&output.stdout).unwrap_or_else(|| media_title(&path));
    transcribe_path_controlled(
        runtime,
        &config,
        &path,
        Some(title),
        Some(youtube_url),
        control,
    )
    .await
    // `temporary` is dropped here on success and on every error path, deleting the download.
}

async fn bundled_tool_version(path: &Path) -> Option<String> {
    if !is_executable_file(path) {
        return None;
    }
    let executable = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || Command::new(executable).arg("--version").output())
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8(output.stdout).ok().and_then(|value| {
                value
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .map(str::trim)
                    .map(str::to_string)
            })
        })
}

#[tauri::command]
pub(super) async fn transcription_setup_status(
    app: AppHandle,
) -> Result<TranscriptionSetupStatus, String> {
    let runtime = bundled_transcription_runtime(&app)?;
    let whisper_version = bundled_tool_version(&runtime.whisper).await;
    let yt_dlp_version = bundled_tool_version(&runtime.yt_dlp).await;
    let deno_version = bundled_tool_version(&runtime.deno).await;
    let model_ready = fs::metadata(&runtime.model)
        .map(|metadata| metadata.is_file() && metadata.len() >= MIN_BUNDLED_MODEL_BYTES)
        .unwrap_or(false);
    let whisper_available = whisper_version.is_some() && model_ready;
    let yt_dlp_available = yt_dlp_version.is_some() && deno_version.is_some();

    let whisper_message = if whisper_available {
        format!(
            "{} and its on-device model are ready.",
            whisper_version.as_deref().unwrap_or("Bundled Whisper")
        )
    } else {
        "The bundled Whisper engine or model is missing. Reinstall Orion.".to_string()
    };
    let youtube_message = if yt_dlp_available {
        format!(
            "Bundled yt-dlp {} and {} are ready.",
            yt_dlp_version.as_deref().unwrap_or(""),
            deno_version.as_deref().unwrap_or("Deno")
        )
    } else {
        "The bundled YouTube tools are incomplete. Reinstall Orion.".to_string()
    };

    Ok(TranscriptionSetupStatus {
        whisper_available,
        whisper_version,
        whisper_model: bundled_whisper_model_label(&runtime),
        yt_dlp_available,
        yt_dlp_version,
        deno_version,
        message: format!("{whisper_message} {youtube_message}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, contents).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(unix)]
    fn fake_transcription_runtime(
        directory: &TempDir,
        whisper_script: &str,
        yt_dlp_script: &str,
    ) -> TranscriptionRuntime {
        let whisper = directory.path().join("orion-whisper");
        let yt_dlp = directory.path().join("yt-dlp");
        let deno = directory.path().join("deno");
        let model = directory.path().join(BUNDLED_WHISPER_MODEL_NAME);
        write_executable(&whisper, whisper_script);
        write_executable(&yt_dlp, yt_dlp_script);
        write_executable(&deno, "#!/bin/sh\nprintf 'deno 2.9.4\\n'\n");
        File::create(&model)
            .unwrap()
            .set_len(MIN_BUNDLED_MODEL_BYTES)
            .unwrap();
        TranscriptionRuntime {
            whisper,
            model,
            yt_dlp,
            deno,
        }
    }

    #[test]
    fn normalizes_optional_transcription_language() {
        let accepted = normalize_transcription_language(WhisperConfig {
            language: Some("en".to_string()),
        })
        .unwrap();
        assert_eq!(accepted.as_deref(), Some("en"));
        assert_eq!(
            normalize_transcription_language(WhisperConfig {
                language: Some(" Auto ".to_string())
            })
            .unwrap(),
            None
        );
        assert!(normalize_transcription_language(WhisperConfig {
            language: Some("../english".to_string())
        })
        .is_err());
    }

    #[test]
    fn validates_voice_memo_container_type_and_bound() {
        let m4a = b"\0\0\0\x18ftypM4A fixture";
        let (file_name, mime_type, decoded) = decode_voice_memo(VoiceMemoRequest {
            file_name: "voice-memo.m4a".to_string(),
            mime_type: "audio/mp4;codecs=mp4a.40.2".to_string(),
            base64_data: BASE64_STANDARD.encode(m4a),
        })
        .unwrap();
        assert_eq!(file_name, "voice-memo.m4a");
        assert_eq!(mime_type, "audio/mp4");
        assert_eq!(&decoded[..], m4a);

        assert!(decode_voice_memo(VoiceMemoRequest {
            file_name: "../memo.m4a".to_string(),
            mime_type: "audio/mp4".to_string(),
            base64_data: BASE64_STANDARD.encode(m4a),
        })
        .is_err());
        assert!(decode_voice_memo(VoiceMemoRequest {
            file_name: "memo.m4a".to_string(),
            mime_type: "audio/webm".to_string(),
            base64_data: BASE64_STANDARD.encode(m4a),
        })
        .is_err());
        assert!(decode_voice_memo(VoiceMemoRequest {
            file_name: "memo.m4a".to_string(),
            mime_type: "audio/mp4".to_string(),
            base64_data: BASE64_STANDARD.encode(b"not-m4a"),
        })
        .is_err());
        assert!(decode_voice_memo(VoiceMemoRequest {
            file_name: "memo.m4a".to_string(),
            mime_type: "audio/mp4".to_string(),
            base64_data: "A".repeat(MAX_VOICE_MEMO_BASE64_BYTES + 1),
        })
        .unwrap_err()
        .contains("64 MB"));
    }

    #[test]
    fn accepts_only_specific_https_youtube_urls() {
        assert!(normalize_youtube_url("https://www.youtube.com/watch?v=abc123").is_ok());
        assert!(normalize_youtube_url("https://youtu.be/abc123").is_ok());
        assert!(normalize_youtube_url("http://youtube.com/watch?v=abc123").is_err());
        assert!(normalize_youtube_url("https://example.com/watch?v=abc123").is_err());
        assert!(normalize_youtube_url("https://youtube.com/").is_err());
    }

    #[test]
    fn extracts_title_from_yt_dlp_json_output() {
        let output = br#"{"id":"abc","title":"A useful conversation"}"#;
        assert_eq!(
            yt_dlp_title(output).as_deref(),
            Some("A useful conversation")
        );
    }

    #[test]
    #[cfg(unix)]
    fn runs_the_bundled_whisper_engine_for_local_media() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = fake_transcription_runtime(
            &directory,
            "#!/bin/sh\nprintf 'A local offline transcript.\\n'\n",
            "#!/bin/sh\nexit 0\n",
        );
        let media = directory.path().join("field-recording.mp3");
        fs::write(&media, b"not-real-audio").unwrap();
        let config = WhisperConfig {
            language: Some("en".to_string()),
        };

        let transcript =
            tauri::async_runtime::block_on(transcribe_path(&runtime, &config, &media, None, None))
                .unwrap();

        assert_eq!(transcript.text, "A local offline transcript.");
        assert_eq!(transcript.file_name, "field-recording.mp3");
    }

    #[cfg(unix)]
    #[test]
    fn media_batch_keeps_successful_siblings_when_a_file_fails() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = fake_transcription_runtime(
            &directory,
            "#!/bin/sh\nprintf 'A recovered transcript.\\n'\n",
            "#!/bin/sh\nexit 0\n",
        );
        let good = directory.path().join("good.mp3");
        let bad = directory.path().join("empty.mp3");
        let later = directory.path().join("later.mp3");
        fs::write(&good, b"audio").unwrap();
        fs::write(&bad, b"").unwrap();
        fs::write(&later, b"more audio").unwrap();
        let batch = tauri::async_runtime::block_on(transcribe_media_paths(
            &runtime,
            &WhisperConfig { language: None },
            vec![Ok(good), Ok(bad), Ok(later)],
            &media_jobs::Control::default(),
        ))
        .unwrap();
        assert_eq!(batch.transcripts.len(), 2);
        assert_eq!(batch.transcripts[0].file_name, "good.mp3");
        assert_eq!(batch.transcripts[1].file_name, "later.mp3");
        assert_eq!(batch.failures.len(), 1);
        assert_eq!(batch.failures[0].file_name, "empty.mp3");
    }

    #[cfg(unix)]
    #[test]
    fn media_batch_retains_completed_files_after_its_overall_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let second_started = directory.path().join("second-started");
        let script = format!("#!/bin/sh\ncase \"$*\" in *slow.mp3*) touch '{}' ; sleep 10 ;; esac\nprintf 'Completed transcript.\\n'\n", second_started.display());
        let runtime = fake_transcription_runtime(&directory, &script, "#!/bin/sh\nexit 0\n");
        let paths: Vec<_> = ["good.mp3", "slow.mp3", "later.mp3"]
            .iter()
            .map(|name| {
                let path = directory.path().join(name);
                fs::write(&path, b"audio").unwrap();
                Ok(path)
            })
            .collect();
        let control = media_jobs::Control::default();
        let clock = control.clone();
        let expire = std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while !second_started.exists() && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(second_started.exists(), "The second recording never began");
            clock.expire_for_test();
        });
        let batch = tauri::async_runtime::block_on(transcribe_media_paths(
            &runtime,
            &WhisperConfig { language: None },
            paths,
            &control,
        ))
        .unwrap();
        expire.join().unwrap();
        assert_eq!(batch.transcripts.len(), 1);
        assert_eq!(batch.transcripts[0].file_name, "good.mp3");
        assert_eq!(batch.failures.len(), 2);
        assert!(batch
            .failures
            .iter()
            .all(|failure| failure.error.contains("limit")));
    }

    #[cfg(unix)]
    #[test]
    fn youtube_workflow_deletes_its_temporary_download() {
        let fixture = tempfile::tempdir().unwrap();
        let temporary_marker = fixture.path().join("temporary-directory.txt");
        let argument_marker = fixture.path().join("yt-dlp-arguments.txt");
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\noutput=\"\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--output\" ]; then\n    shift\n    output=\"$1\"\n  fi\n  shift\ndone\ndirectory=$(dirname \"$output\")\nprintf '%s' \"$directory\" > \"{}\"\nprintf 'fake-youtube-audio' > \"$directory/orion-media.m4a\"\nprintf '{{\"title\":\"Recorded dialogue\"}}\\n'\n",
            argument_marker.display(),
            temporary_marker.display()
        );
        let runtime = fake_transcription_runtime(
            &fixture,
            "#!/bin/sh\nprintf 'A video transcript.\\n'\n",
            &script,
        );

        let transcript = tauri::async_runtime::block_on(transcribe_youtube_with_runtime(
            &runtime,
            YouTubeTranscriptionRequest {
                url: "https://youtu.be/orion-example".to_string(),
                language: None,
            },
        ))
        .unwrap();

        assert_eq!(transcript.title, "Recorded dialogue");
        assert_eq!(transcript.text, "A video transcript.");
        assert_eq!(
            transcript.source_url.as_deref(),
            Some("https://youtu.be/orion-example")
        );
        let temporary_path = fs::read_to_string(&temporary_marker).unwrap();
        assert!(!Path::new(&temporary_path).exists());
        let arguments = fs::read_to_string(&argument_marker).unwrap();
        assert!(arguments.contains("--ignore-config"));
        assert!(arguments.contains("--no-simulate"));
        assert!(arguments.contains("--js-runtimes"));
        assert!(arguments.contains(&format!("deno:{}", runtime.deno.display())));
    }

    #[cfg(unix)]
    #[test]
    fn youtube_workflow_does_not_download_when_bundled_whisper_is_missing() {
        let fixture = tempfile::tempdir().unwrap();
        let marker = fixture.path().join("yt-dlp-ran");
        let mut runtime = fake_transcription_runtime(
            &fixture,
            "#!/bin/sh\nprintf 'unused transcript\\n'\n",
            &format!("#!/bin/sh\ntouch \"{}\"\n", marker.display()),
        );
        runtime.whisper = fixture.path().join("missing-whisper");

        let error = tauri::async_runtime::block_on(transcribe_youtube_with_runtime(
            &runtime,
            YouTubeTranscriptionRequest {
                url: "https://youtu.be/orion-example".to_string(),
                language: None,
            },
        ))
        .err()
        .unwrap();

        assert!(error.contains("bundled Whisper engine"));
        assert!(!marker.exists());
    }
}
