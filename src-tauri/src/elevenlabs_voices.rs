//! User-initiated voice cloning and settings. Files originate only in the native picker.
use super::*;
const BASE: &str = "https://api.elevenlabs.io";
const MAX_SAMPLES: usize = 20;
const MAX_TOTAL: usize = 50 * 1024 * 1024;
#[derive(Default)]
pub struct Samples(
    Mutex<HashMap<String, StagedSamples>>,
    Mutex<HashMap<String, u64>>,
);
struct StagedSamples {
    generation: u64,
    files: Vec<Sample>,
}
impl Samples {
    fn begin_pick(&self, owner: &str) -> Result<u64, String> {
        let mut generations = self
            .1
            .lock()
            .map_err(|_| "Could not prepare audio import.")?;
        let generation = generations.entry(owner.to_string()).or_default();
        *generation = generation.wrapping_add(1);
        Ok(*generation)
    }
    pub fn clear_owner(&self, owner: &str) {
        if let Ok(mut generations) = self.1.lock() {
            let generation = generations.entry(owner.to_string()).or_default();
            *generation = generation.wrapping_add(1);
            if let Ok(mut staged) = self.0.lock() {
                staged.remove(owner);
            }
        }
    }
    fn stage(&self, owner: &str, generation: u64, samples: Vec<Sample>) -> Result<bool, String> {
        let generations = self
            .1
            .lock()
            .map_err(|_| "Could not stage audio samples.")?;
        if generations.get(owner) != Some(&generation) {
            return Ok(false);
        }
        self.0
            .lock()
            .map_err(|_| "Could not stage audio samples.")?
            .insert(
                owner.to_string(),
                StagedSamples {
                    generation,
                    files: samples,
                },
            );
        Ok(true)
    }
    fn clear_uploaded(&self, owner: &str, generation: Option<u64>) {
        if let Ok(mut staged) = self.0.lock() {
            if staged
                .get(owner)
                .is_some_and(|batch| Some(batch.generation) == generation)
            {
                staged.remove(owner);
            }
        }
    }
}
struct Sample {
    name: String,
    mime: &'static str,
    bytes: Vec<u8>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedSample {
    name: String,
    bytes: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceSettings {
    stability: f64,
    similarity_boost: f64,
    style: f64,
    speed: f64,
    use_speaker_boost: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clone_strength: Option<f64>,
}
impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            speed: 1.0,
            use_speaker_boost: true,
            clone_strength: None,
        }
    }
}
fn validate_settings(s: &VoiceSettings) -> Result<(), String> {
    for value in [s.stability, s.similarity_boost, s.style]
        .into_iter()
        .chain(s.clone_strength)
    {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err("Voice controls must be between 0 and 1.".into());
        }
    }
    if !s.speed.is_finite() || !(0.7..=1.2).contains(&s.speed) {
        return Err("Voice speed must be between 0.7 and 1.2.".into());
    }
    Ok(())
}
fn settings(value: &Value) -> VoiceSettings {
    let defaults = VoiceSettings::default();
    let out = VoiceSettings {
        stability: value["stability"].as_f64().unwrap_or(defaults.stability),
        similarity_boost: value["similarity_boost"]
            .as_f64()
            .unwrap_or(defaults.similarity_boost),
        style: value["style"].as_f64().unwrap_or(0.0),
        speed: value["speed"].as_f64().unwrap_or(1.0),
        use_speaker_boost: value["use_speaker_boost"].as_bool().unwrap_or(true),
        clone_strength: value["clone_strength"].as_f64(),
    };
    if validate_settings(&out).is_ok() {
        out
    } else {
        defaults
    }
}
fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        Some("audio/wav")
    } else if bytes.starts_with(b"fLaC") {
        Some("audio/flac")
    } else if bytes.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if bytes.starts_with(b"ID3")
        || bytes.len() > 1 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0
    {
        Some("audio/mpeg")
    } else if bytes.get(4..8) == Some(b"ftyp") {
        Some("audio/mp4")
    } else if bytes.starts_with(b"FORM") && matches!(bytes.get(8..12), Some(b"AIFF" | b"AIFC")) {
        Some("audio/aiff")
    } else {
        None
    }
}
pub fn validate_model_id(model: Option<&str>) -> Result<String, String> {
    let model = model
        .filter(|s| !s.is_empty())
        .unwrap_or("eleven_multilingual_v2");
    if model.len() <= "eleven_".len()
        || model.len() > 100
        || !model.starts_with("eleven_")
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
    {
        return Err("Choose a valid ElevenLabs speech model.".into());
    }
    Ok(model.to_string())
}
fn preview_settings(controls: &VoiceSettings, model: &str) -> Value {
    let mut value = serde_json::to_value(controls).unwrap();
    if model.starts_with("eleven_v3") {
        for key in [
            "speed",
            "similarity_boost",
            "style",
            "use_speaker_boost",
            "clone_strength",
        ] {
            value.as_object_mut().unwrap().remove(key);
        }
        value["stability"] = json!((controls.stability * 2.0).round() / 2.0);
    } else if model.starts_with("eleven_v4") {
        for key in ["speed", "style", "use_speaker_boost"] {
            value.as_object_mut().unwrap().remove(key);
        }
    } else {
        value.as_object_mut().unwrap().remove("clone_strength");
    }
    value
}
fn explicit_voice_id(id: &str) -> Result<String, String> {
    if id.is_empty() || id.trim() != id {
        return Err("Choose a valid ElevenLabs voice.".into());
    }
    validate_elevenlabs_voice_id(Some(id))
}
async fn key() -> Result<Zeroizing<String>, String> {
    stored_elevenlabs_api_key()
        .await?
        .ok_or("Add an ElevenLabs API key in Settings first.".into())
}
async fn checked(response: Response) -> Result<Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    // Provider bodies can contain names, sample details and request text; never echo them.
    Err(match status {
        401 => "ElevenLabs rejected the saved key. Replace it in Settings.".into(),
        403 => "This ElevenLabs key or plan does not allow that operation. Check its voice permissions and plan.".into(),
        429 => "ElevenLabs reached a rate or usage limit. Check your ElevenLabs account.".into(),
        400 | 422 => "ElevenLabs could not accept these voice details or audio samples. Check the samples, controls and account verification.".into(),
        _ => format!("ElevenLabs could not complete the request (HTTP {status}). Check your voice library before retrying creation."),
    })
}
async fn json_response(response: Response) -> Result<Value, String> {
    let mut response = checked(response).await?;
    const LIMIT: usize = 4 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > LIMIT as u64)
    {
        return Err("The ElevenLabs response exceeded its limit. Check your voice library before retrying creation.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "The ElevenLabs response was interrupted. Check your voice library before retrying creation.")? {
        if bytes.len().saturating_add(chunk.len()) > LIMIT { return Err("The ElevenLabs response exceeded its limit. Check your voice library before retrying creation.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "ElevenLabs returned invalid voice data. Check your voice library before retrying creation.".into())
}
fn voice_summary(v: &Value) -> Option<Value> {
    let id = v["voice_id"].as_str()?;
    explicit_voice_id(id).ok()?;
    let samples = v["samples"].as_array().into_iter().flatten().take(100).filter_map(|s| {
        let id = s["sample_id"].as_str()?;
        if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { return None; }
        Some(json!({ "id": id, "name": bounded_text(s["file_name"].as_str().unwrap_or("Audio sample"), 160) }))
    }).collect::<Vec<_>>();
    Some(
        json!({ "id":id, "name":bounded_text(v["name"].as_str().unwrap_or("Voice"),80), "description":bounded_text(v["description"].as_str().unwrap_or_default(),1000), "category":bounded_text(v["category"].as_str().unwrap_or_default(),80), "requiresVerification": v["voice_verification"]["requires_verification"] == true && v["voice_verification"]["is_verified"] != true, "labels": v["labels"].as_object().map(|o| o.iter().filter(|(k,_)| ["language","accent","gender","age"].contains(&k.as_str())).map(|(k,v)| (k.clone(),json!(bounded_text(v.as_str().unwrap_or_default(),80)))).collect::<serde_json::Map<_,_>>()).unwrap_or_default(), "settings":settings(&v["settings"]), "samples":samples }),
    )
}
fn read_samples(paths: Vec<PathBuf>) -> Result<Vec<Sample>, String> {
    if paths.is_empty() || paths.len() > MAX_SAMPLES {
        return Err("Choose between 1 and 20 audio samples.".into());
    }
    let mut samples = Vec::new();
    let mut total = 0usize;
    for path in paths {
        // Reject directories and special files before opening: a named pipe can block a reader.
        let metadata =
            std::fs::metadata(&path).map_err(|_| "Could not read the selected recording.")?;
        if !metadata.is_file() {
            return Err("Choose a local audio recording file.".into());
        }
        let mut file =
            File::open(&path).map_err(|_| "Could not open one of the selected recordings.")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Could not read the selected recording.")?;
        let size = metadata.len();
        if !metadata.is_file()
            || size == 0
            || size > MAX_TOTAL as u64
            || total as u64 + size > MAX_TOTAL as u64
        {
            return Err("Choose nonempty recordings totalling no more than 50 MB.".into());
        }
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(&mut file, (MAX_TOTAL - total + 1) as u64),
            &mut bytes,
        )
        .map_err(|_| "Could not read the selected recording.")?;
        total += bytes.len();
        if total > MAX_TOTAL {
            return Err("The recordings exceed 50 MB.".into());
        }
        let mime =
            mime(&bytes).ok_or("Choose WAV, MP3, M4A, FLAC, OGG or AIFF audio recordings.")?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("recording.wav")
            .chars()
            .filter(|c| !c.is_control())
            .take(160)
            .collect();
        samples.push(Sample { name, mime, bytes });
    }
    Ok(samples)
}
#[tauri::command]
pub async fn elevenlabs_pick_samples(
    window: tauri::WebviewWindow,
    app: AppHandle,
    staged: State<'_, Samples>,
) -> Result<Vec<PickedSample>, String> {
    let generation = staged.begin_pick(window.label())?;
    let paths = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(
                "Voice recordings",
                &["wav", "mp3", "m4a", "flac", "ogg", "aif", "aiff"],
            )
            .blocking_pick_files()
    })
    .await
    .map_err(|_| "The audio picker could not open.")?;
    let Some(paths) = paths else {
        return Ok(vec![]);
    };
    let samples = tauri::async_runtime::spawn_blocking(move || {
        let paths = paths
            .into_iter()
            .map(|path| match path {
                FilePath::Path(path) => Ok(path),
                _ => Err("Choose a local audio recording.".to_string()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        read_samples(paths)
    })
    .await
    .map_err(|_| "The audio import task could not finish.")??;
    let result = samples
        .iter()
        .map(|s| PickedSample {
            name: s.name.clone(),
            bytes: s.bytes.len(),
        })
        .collect();
    if !staged.stage(window.label(), generation, samples)? {
        return Ok(vec![]);
    }
    Ok(result)
}
#[tauri::command]
pub fn elevenlabs_clear_samples(window: tauri::WebviewWindow, staged: State<'_, Samples>) {
    staged.clear_owner(window.label());
}
#[tauri::command]
pub async fn elevenlabs_list_voices(
    client: State<'_, OpenAiClient>,
    next_page: Option<String>,
) -> Result<Value, String> {
    if let Some(page) = next_page.as_deref() {
        validate_page_token(page)?;
    }
    let key = key().await?;
    request_voice_library(&client.0, key.as_str(), next_page.as_deref()).await
}
async fn request_voice_library(
    client: &Client,
    api_key: &str,
    next_page: Option<&str>,
) -> Result<Value, String> {
    let mut url = Url::parse(&format!("{BASE}/v2/voices")).unwrap();
    url.query_pairs_mut().append_pair("page_size", "100");
    if let Some(page) = next_page {
        validate_page_token(page)?;
        url.query_pairs_mut().append_pair("next_page_token", page);
    }
    let data = json_response(
        client
            .get(url)
            .header("xi-api-key", api_key)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Could not load the ElevenLabs voice library.")?,
    )
    .await?;
    library_page(&data, next_page)
}
fn validate_page_token(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 2048 || token.chars().any(char::is_control) {
        return Err("Invalid voice library page.".into());
    }
    Ok(())
}
fn library_page(data: &Value, previous_page: Option<&str>) -> Result<Value, String> {
    let has_more = data["has_more"]
        .as_bool()
        .ok_or("ElevenLabs returned invalid voice library pagination.")?;
    let next_page = if has_more {
        let token = data["next_page_token"].as_str().ok_or("ElevenLabs did not return the next voice library page. Refresh the library to try again.")?;
        validate_page_token(token)?;
        if Some(token) == previous_page {
            return Err(
                "ElevenLabs repeated the voice library page. Refresh the library to try again."
                    .into(),
            );
        }
        Some(token)
    } else {
        None
    };
    let voices = data["voices"]
        .as_array()
        .ok_or("ElevenLabs returned an invalid voice library.")?
        .iter()
        .filter_map(voice_summary)
        .collect::<Vec<_>>();
    Ok(json!({ "voices": voices, "nextPage": next_page }))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneRequest {
    name: String,
    description: String,
    labels: HashMap<String, String>,
    remove_background_noise: bool,
    #[serde(default)]
    voice_id: Option<String>,
}
fn validate_details(request: &CloneRequest) -> Result<(), String> {
    if request.name.trim().is_empty()
        || request.name.chars().count() > 80
        || request.description.chars().count() > 1000
        || request.name.chars().any(char::is_control)
        || request
            .description
            .chars()
            .any(|c| c.is_control() && c != '\n')
    {
        return Err(
            "Enter a voice name of 1–80 characters and a description up to 1,000 characters."
                .into(),
        );
    }
    if request.labels.len() > 4
        || request.labels.iter().any(|(k, v)| {
            !["language", "accent", "gender", "age"].contains(&k.as_str())
                || v.chars().count() > 80
                || v.chars().any(char::is_control)
        })
    {
        return Err("Use language, accent, gender and age labels of up to 80 characters.".into());
    }
    if let Some(id) = &request.voice_id {
        explicit_voice_id(id)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn elevenlabs_clone_voice(
    window: tauri::WebviewWindow,
    staged: State<'_, Samples>,
    client: State<'_, OpenAiClient>,
    request: CloneRequest,
) -> Result<Value, String> {
    validate_details(&request)?;
    let key = key().await?;
    // Retain staged originals on failure, without ever retrying a creation POST automatically.
    let (generation, parts) = {
        let samples = staged
            .0
            .lock()
            .map_err(|_| "Could not read the staged recordings.")?;
        let samples = samples.get(window.label());
        if request.voice_id.is_none() && samples.is_none_or(|batch| batch.files.is_empty()) {
            return Err("Import audio samples before creating a clone.".into());
        }
        let parts = samples
            .into_iter()
            .flat_map(|batch| &batch.files)
            .map(|s| {
                reqwest::multipart::Part::bytes(s.bytes.clone())
                    .file_name(s.name.clone())
                    .mime_str(s.mime)
                    .map_err(|_| "Invalid sample format.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        (samples.map(|batch| batch.generation), parts)
    };
    let mut form = reqwest::multipart::Form::new()
        .text("name", request.name.trim().to_string())
        .text("description", request.description)
        .text("labels", serde_json::to_string(&request.labels).unwrap())
        .text(
            "remove_background_noise",
            request.remove_background_noise.to_string(),
        );
    for part in parts {
        form = form.part("files", part);
    }
    let url = request
        .voice_id
        .as_ref()
        .map(|id| format!("{BASE}/v1/voices/{id}/edit"))
        .unwrap_or_else(|| format!("{BASE}/v1/voices/add"));
    let data = json_response(client.0.post(url).header("xi-api-key", key.as_str()).multipart(form).timeout(Duration::from_secs(180)).send().await.map_err(|_| "The voice upload did not complete. Check your ElevenLabs voice library before retrying; a clone may already exist.")?).await?;
    let result = clone_result(&data, request.voice_id.as_deref())?;
    staged.clear_uploaded(window.label(), generation);
    Ok(result)
}
fn clone_result(data: &Value, existing_id: Option<&str>) -> Result<Value, String> {
    if existing_id.is_some() && data["status"] != "ok" {
        return Err("ElevenLabs did not confirm the voice update.".into());
    }
    let id = existing_id
        .or_else(|| data["voice_id"].as_str())
        .ok_or("ElevenLabs did not return a voice ID. Check your voice library before retrying.")?;
    explicit_voice_id(id).map_err(|_| {
        "ElevenLabs returned an invalid voice ID. Check your voice library before retrying."
    })?;
    // Creation requires this flag. An incomplete success response must never auto-select a clone.
    let requires_verification = if existing_id.is_none() {
        data["requires_verification"].as_bool().ok_or("ElevenLabs did not confirm whether this clone requires verification. Check your voice library before retrying creation.")?
    } else {
        data["requires_verification"].as_bool().unwrap_or(false)
    };
    Ok(json!({ "id":id, "requiresVerification": requires_verification }))
}
#[tauri::command]
pub async fn elevenlabs_get_voice(
    client: State<'_, OpenAiClient>,
    voice_id: String,
) -> Result<Value, String> {
    let id = explicit_voice_id(&voice_id)?;
    let key = key().await?;
    request_voice(&client.0, key.as_str(), &id).await
}
async fn request_voice(client: &Client, api_key: &str, voice_id: &str) -> Result<Value, String> {
    let id = explicit_voice_id(voice_id)?;
    let data = json_response(
        client
            .get(format!("{BASE}/v1/voices/{id}"))
            .header("xi-api-key", api_key)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Could not load this ElevenLabs voice.")?,
    )
    .await?;
    if data["voice_id"] != id {
        return Err(
            "ElevenLabs returned details for a different voice. Refresh the library to try again."
                .into(),
        );
    }
    voice_summary(&data).ok_or("ElevenLabs returned invalid voice details.".into())
}
#[tauri::command]
pub async fn elevenlabs_save_voice_settings(
    client: State<'_, OpenAiClient>,
    voice_id: String,
    settings: VoiceSettings,
) -> Result<(), String> {
    let id = explicit_voice_id(&voice_id)?;
    validate_settings(&settings)?;
    let key = key().await?;
    let data = json_response(
        client
            .0
            .post(format!("{BASE}/v1/voices/{id}/settings/edit"))
            .header("xi-api-key", key.as_str())
            .json(&settings)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Could not save the ElevenLabs voice controls.")?,
    )
    .await?;
    if data["status"] != "ok" {
        return Err("ElevenLabs did not confirm the voice settings save.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn elevenlabs_voice_models(client: State<'_, OpenAiClient>) -> Result<Value, String> {
    let key = key().await?;
    request_voice_models(&client.0, key.as_str()).await
}
async fn request_voice_models(client: &Client, api_key: &str) -> Result<Value, String> {
    let data = json_response(
        client
            .get(format!("{BASE}/v1/models"))
            .header("xi-api-key", api_key)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Could not load ElevenLabs speech models.")?,
    )
    .await?;
    model_catalog(&data)
}
fn model_catalog(data: &Value) -> Result<Value, String> {
    Ok(json!(data.as_array().ok_or("Invalid speech model catalog.")?.iter().filter(|m| m["can_do_text_to_speech"] == true).filter_map(|m| {
        let id = m["model_id"].as_str()?;
        if id.is_empty() { return None; }
        validate_model_id(Some(id)).ok()?;
        Some(json!({ "id":id, "name":bounded_text(m["name"].as_str().unwrap_or(id),100), "supportsStyle": m["supports_style"].as_bool().unwrap_or(false), "supportsSpeakerBoost":m["supports_speaker_boost"].as_bool().unwrap_or(false) }))
    }).take(50).collect::<Vec<_>>()))
}
#[tauri::command]
pub async fn elevenlabs_preview_voice(
    client: State<'_, OpenAiClient>,
    voice_id: String,
    model_id: String,
    text: String,
    settings: VoiceSettings,
) -> Result<Value, String> {
    validate_preview_request(&voice_id, &model_id, &text, &settings)?;
    let key = key().await?;
    request_voice_preview(
        &client.0,
        key.as_str(),
        &voice_id,
        &model_id,
        &text,
        &settings,
    )
    .await
}
fn validate_preview_request(
    voice_id: &str,
    model_id: &str,
    text: &str,
    controls: &VoiceSettings,
) -> Result<(), String> {
    explicit_voice_id(voice_id)?;
    validate_settings(controls)?;
    if model_id.is_empty()
        || model_id.len() > 100
        || !model_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
        || text.trim().is_empty()
        || text.chars().count() > 1000
    {
        return Err("Choose a speech model and preview text of 1–1,000 characters.".into());
    }
    validate_model_id(Some(model_id))?;
    Ok(())
}
async fn request_voice_preview(
    client: &Client,
    api_key: &str,
    voice_id: &str,
    model_id: &str,
    text: &str,
    controls: &VoiceSettings,
) -> Result<Value, String> {
    validate_preview_request(voice_id, model_id, text, controls)?;
    let response = checked(client.post(format!("{BASE}/v1/text-to-speech/{voice_id}")).query(&[("output_format", "mp3_44100_128")]).header("xi-api-key", api_key).header(reqwest::header::ACCEPT, "audio/mpeg").json(&json!({"text":text,"model_id":model_id,"voice_settings":preview_settings(controls, model_id)})).timeout(Duration::from_secs(90)).send().await.map_err(|_| "The voice preview could not be generated.")?).await?;
    let bytes = read_speech_response(response, 8 * 1024 * 1024).await?;
    preview_audio(bytes)
}
fn preview_audio(bytes: Vec<u8>) -> Result<Value, String> {
    if bytes.is_empty() {
        return Err("ElevenLabs returned an empty preview.".into());
    }
    if mime(&bytes) != Some("audio/mpeg") {
        return Err(
            "ElevenLabs returned invalid preview audio. Try generating the preview again.".into(),
        );
    }
    Ok(json!({ "audio": BASE64_STANDARD.encode(bytes), "mime":"audio/mpeg" }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_controls_and_fake_audio() {
        let mut controls = VoiceSettings::default();
        assert!(validate_settings(&controls).is_ok());
        controls.speed = 5.0;
        assert!(validate_settings(&controls).is_err());
        controls.speed = 1.0;
        controls.stability = f64::NAN;
        assert!(validate_settings(&controls).is_err());
        assert!(mime(b"not an audio file").is_none());
        assert_eq!(mime(b"RIFFxxxxWAVEdata"), Some("audio/wav"));
    }
    #[test]
    fn stale_audio_imports_cannot_revive_after_disposal() {
        let store = Samples::default();
        let generation = store.begin_pick("a").unwrap();
        let other = store.begin_pick("b").unwrap();
        store.clear_owner("a");
        assert!(!store.stage("a", generation, vec![]).unwrap());
        assert!(store.stage("b", other, vec![]).unwrap());
    }
    #[test]
    fn bounds_cloning_metadata() {
        let mut request = CloneRequest {
            name: "My voice".into(),
            description: String::new(),
            labels: HashMap::new(),
            remove_background_noise: false,
            voice_id: None,
        };
        assert!(validate_details(&request).is_ok());
        request.labels.insert("arbitrary".into(), "x".into());
        assert!(validate_details(&request).is_err());
        request.labels.clear();
        request.name = "x".repeat(81);
        assert!(validate_details(&request).is_err());
    }
    fn sample(name: &str) -> Sample {
        Sample {
            name: name.into(),
            mime: "audio/wav",
            bytes: b"RIFFxxxxWAVEdata".to_vec(),
        }
    }
    #[test]
    fn successful_upload_only_clears_its_own_sample_generation_and_window() {
        let store = Samples::default();
        let first = store.begin_pick("a").unwrap();
        store.stage("a", first, vec![sample("first.wav")]).unwrap();
        let other = store.begin_pick("b").unwrap();
        store.stage("b", other, vec![sample("other.wav")]).unwrap();
        let replacement = store.begin_pick("a").unwrap();
        store
            .stage("a", replacement, vec![sample("replacement.wav")])
            .unwrap();
        store.clear_uploaded("a", Some(first));
        assert_eq!(
            store.0.lock().unwrap()["a"].files[0].name,
            "replacement.wav"
        );
        store.clear_uploaded("a", None);
        assert!(store.0.lock().unwrap().contains_key("a"));
        store.clear_uploaded("a", Some(replacement));
        assert!(!store.0.lock().unwrap().contains_key("a"));
        assert_eq!(store.0.lock().unwrap()["b"].files[0].name, "other.wav");
        store.clear_owner("b");
        assert!(store.0.lock().unwrap().is_empty());
    }
    #[test]
    fn uploaded_batch_does_not_cancel_a_new_picker_and_old_picker_cannot_replace_newer_one() {
        let store = Samples::default();
        let first = store.begin_pick("a").unwrap();
        store.stage("a", first, vec![sample("first.wav")]).unwrap();
        let pending = store.begin_pick("a").unwrap();
        store.clear_uploaded("a", Some(first));
        assert!(store.stage("a", pending, vec![sample("next.wav")]).unwrap());
        assert!(!store.stage("a", first, vec![sample("stale.wav")]).unwrap());
        assert_eq!(store.0.lock().unwrap()["a"].files[0].name, "next.wav");
    }
    #[test]
    fn native_sample_reader_bounds_files_and_uses_content_not_extension() {
        let directory = tempfile::tempdir().unwrap();
        let audio = directory.path().join("sample\n.txt");
        std::fs::write(&audio, b"RIFFxxxxWAVEdata").unwrap();
        let samples = read_samples(vec![audio.clone()]).unwrap();
        assert_eq!(samples[0].name, "sample.txt");
        assert_eq!(samples[0].mime, "audio/wav");
        assert!(read_samples(vec![]).is_err());
        assert!(read_samples(vec![audio.clone(); MAX_SAMPLES + 1]).is_err());
        assert!(read_samples(vec![directory.path().to_path_buf()]).is_err());
        let fake = directory.path().join("fake.wav");
        std::fs::write(&fake, b"This is not audio").unwrap();
        assert!(read_samples(vec![fake]).is_err());
        let huge = directory.path().join("huge.wav");
        let file = File::create(&huge).unwrap();
        assert!(read_samples(vec![huge.clone()]).is_err());
        file.set_len(MAX_TOTAL as u64 + 1).unwrap();
        assert!(read_samples(vec![huge]).is_err());
        // A valid first signature does not bypass the aggregate bound across files.
        let large = directory.path().join("large.wav");
        std::fs::write(&large, b"RIFFxxxxWAVEdata").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&large)
            .unwrap()
            .set_len(MAX_TOTAL as u64)
            .unwrap();
        assert!(read_samples(vec![large, audio]).is_err());
    }
    #[test]
    fn explicit_voice_operations_never_default_blank_or_malformed_ids() {
        for id in ["", " ", "21m00Tcm4TlvDq8ikWAM ", "../voices/other", "short"] {
            assert!(explicit_voice_id(id).is_err(), "{id:?}");
            assert!(voice_summary(&json!({"voice_id":id})).is_none());
        }
        assert_eq!(
            explicit_voice_id("21m00Tcm4TlvDq8ikWAM").unwrap(),
            "21m00Tcm4TlvDq8ikWAM"
        );
    }
    #[test]
    fn creation_requires_valid_id_and_explicit_verification_before_selection() {
        let id = "21m00Tcm4TlvDq8ikWAM";
        for requires in [true, false] {
            let result = clone_result(
                &json!({"voice_id":id,"requires_verification":requires}),
                None,
            )
            .unwrap();
            assert_eq!(result["requiresVerification"], requires);
        }
        for data in [
            json!({"voice_id":id}),
            json!({"voice_id":id,"requires_verification":"false"}),
            json!({"voice_id":"","requires_verification":false}),
            json!({"status":"ok"}),
        ] {
            let error = clone_result(&data, None).unwrap_err();
            assert!(error.contains("voice library"));
        }
        assert_eq!(
            clone_result(&json!({"status":"ok"}), Some(id)).unwrap()["id"],
            id
        );
        assert!(clone_result(&json!({"status":"failed"}), Some(id)).is_err());
    }
    #[test]
    fn voice_library_preserves_verification_and_bounds_display_data() {
        let mut voice = json!({"voice_id":"21m00Tcm4TlvDq8ikWAM","name":"x".repeat(200),"category":"cloned", "voice_verification":{"requires_verification":true,"is_verified":false}, "labels":{"accent":"Australian","secret":"drop"},"samples":[{"sample_id":"sample_1","file_name":"test.wav"},{"sample_id":"../private","file_name":"bad"}]});
        let summary = voice_summary(&voice).unwrap();
        assert_eq!(summary["requiresVerification"], true);
        assert!(summary["name"].as_str().unwrap().chars().count() <= 80);
        assert_eq!(summary["labels"], json!({"accent":"Australian"}));
        assert_eq!(summary["samples"].as_array().unwrap().len(), 1);
        voice["voice_verification"]["is_verified"] = json!(true);
        assert_eq!(
            voice_summary(&voice).unwrap()["requiresVerification"],
            false
        );
    }
    #[test]
    fn library_pagination_never_silently_discards_or_repeats_remaining_pages() {
        let page = json!({"voices":[],"has_more":true,"next_page_token":"opaque+=/next"});
        assert_eq!(
            library_page(&page, None).unwrap()["nextPage"],
            "opaque+=/next"
        );
        assert!(library_page(&page, Some("opaque+=/next")).is_err());
        for token in [
            Value::Null,
            json!(""),
            json!("x".repeat(2049)),
            json!("line\nfeed"),
        ] {
            assert!(library_page(
                &json!({"voices":[],"has_more":true,"next_page_token":token}),
                None
            )
            .is_err());
        }
        assert!(library_page(&json!({"voices":[]}), None).is_err());
        assert!(library_page(&json!({"voices":{},"has_more":false}), None).is_err());
        assert!(library_page(
            &json!({"voices":[],"has_more":false,"next_page_token":"ignored"}),
            None
        )
        .unwrap()["nextPage"]
            .is_null());
    }
    #[test]
    fn preview_settings_follow_model_capabilities_without_changing_saved_controls() {
        let controls = VoiceSettings {
            stability: 0.72,
            style: 0.4,
            speed: 1.1,
            clone_strength: Some(0.8),
            ..VoiceSettings::default()
        };
        assert_eq!(
            preview_settings(&controls, "eleven_v3"),
            json!({"stability":0.5})
        );
        for model in ["eleven_v4", "eleven_v4_turbo"] {
            assert_eq!(
                preview_settings(&controls, model),
                json!({"stability":0.72,"similarity_boost":0.75,"clone_strength":0.8})
            );
        }
        let v2 = preview_settings(&controls, "eleven_multilingual_v2");
        assert!(v2.get("clone_strength").is_none());
        assert_eq!(v2["speed"], 1.1);
        assert_eq!(controls.clone_strength, Some(0.8));
        assert_eq!(controls.stability, 0.72);
    }
    #[test]
    fn model_catalog_excludes_non_speech_and_unusable_ids() {
        let catalog = model_catalog(&json!([
            {"model_id":"eleven_v4","name":"Eleven v4","can_do_text_to_speech":true},
            {"model_id":"eleven_","can_do_text_to_speech":true},
            {"model_id":"","can_do_text_to_speech":true},
            {"model_id":"../../other","can_do_text_to_speech":true},
            {"model_id":"eleven_transcribe","can_do_text_to_speech":false}
        ]))
        .unwrap();
        assert_eq!(catalog.as_array().unwrap().len(), 1);
        assert_eq!(catalog[0]["id"], "eleven_v4");
        assert!(model_catalog(&json!({})).is_err());
    }
    #[test]
    fn preview_rejects_empty_or_non_audio_success_responses() {
        assert!(preview_audio(vec![]).is_err());
        assert!(preview_audio(br#"{"detail":"provider error"}"#.to_vec()).is_err());
        let result = preview_audio(b"ID3\x04\0\0\0\0\0\0audio".to_vec()).unwrap();
        assert_eq!(result["mime"], "audio/mpeg");
        assert!(!result["audio"].as_str().unwrap().is_empty());
    }
    async fn fixture_response(status: &str, headers: &str, body: Vec<u8>) -> Response {
        fixture_response_with_client(Client::new(), status, headers, body).await
    }
    async fn fixture_response_with_client(
        client: Client,
        status: &str,
        headers: &str,
        body: Vec<u8>,
    ) -> Response {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let head = format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n");
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        });
        client
            .get(format!("http://{address}"))
            .header("xi-api-key", "synthetic-test-key")
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn provider_client_refuses_redirect_without_forwarding_voice_credentials() {
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let response = fixture_response_with_client(
            provider_http_client().unwrap(),
            "307 Temporary Redirect",
            &format!(
                "Location: http://{}/secret-target\r\nContent-Length: 0\r\n",
                target.local_addr().unwrap()
            ),
            vec![],
        )
        .await;
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        assert!(
            matches!(target.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        assert!(json_response(response)
            .await
            .unwrap_err()
            .contains("HTTP 307"));
    }
    #[tokio::test]
    async fn voice_json_bounds_reject_malformed_truncated_and_oversized_responses() {
        let data = json_response(
            fixture_response(
                "200 OK",
                "Content-Length: 15\r\n",
                br#"{"status":"ok"}"#.to_vec(),
            )
            .await,
        )
        .await
        .unwrap();
        assert_eq!(data["status"], "ok");
        let error =
            json_response(fixture_response("200 OK", "Content-Length: 9000000\r\n", vec![]).await)
                .await
                .unwrap_err();
        assert!(error.contains("exceeded"));
        let error = json_response(
            fixture_response(
                "200 OK",
                "Content-Length: 100\r\n",
                b"{\"status\":".to_vec(),
            )
            .await,
        )
        .await
        .unwrap_err();
        assert!(error.contains("interrupted"));
        let error = json_response(
            fixture_response("200 OK", "", b"private invalid response".to_vec()).await,
        )
        .await
        .unwrap_err();
        assert!(!error.contains("private"));
        assert!(error.contains("Check your voice library"));
        let error =
            json_response(fixture_response("200 OK", "", vec![b' '; 4 * 1024 * 1024 + 1]).await)
                .await
                .unwrap_err();
        assert!(error.contains("exceeded"));
    }
    #[tokio::test]
    async fn failed_voice_requests_do_not_echo_provider_details() {
        for (status, expected) in [
            ("401 Unauthorized", "saved key"),
            ("403 Forbidden", "permissions"),
            ("429 Too Many Requests", "usage limit"),
            ("422 Unprocessable Entity", "voice details"),
            ("500 Server Error", "voice library"),
        ] {
            let error = json_response(
                fixture_response(status, "", b"PRIVATE NAME OR REQUEST TEXT".to_vec()).await,
            )
            .await
            .unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("PRIVATE"));
        }
    }
    #[tokio::test]
    async fn preview_audio_limits_reject_declared_and_streamed_oversize_before_encoding() {
        let response = fixture_response("200 OK", "Content-Length: 8388609\r\n", vec![]).await;
        assert!(read_speech_response(response, 8 * 1024 * 1024)
            .await
            .unwrap_err()
            .contains("too large"));
        // Exercise chunk accounting without relying on a Content-Length header.
        let response = fixture_response("200 OK", "", vec![b'x'; 1025]).await;
        assert!(read_speech_response(response, 1024)
            .await
            .unwrap_err()
            .contains("too large"));
    }
    /// Opt in explicitly: reads the production Keychain through the normal module path,
    /// performs three catalog/detail GETs, then exactly one short paid speech request.
    /// Never uploads samples, creates/edits a voice, or writes remote voice settings.
    #[tokio::test]
    #[ignore = "explicit opt-in: production ElevenLabs Keychain and one synthetic speech preview"]
    async fn live_voice_library_models_and_one_preview() -> Result<(), String> {
        if std::env::var("ORION_ELEVENLABS_LIVE_QA").as_deref() != Ok("1") {
            return Err(
                "Set ORION_ELEVENLABS_LIVE_QA=1 to explicitly authorize this live probe.".into(),
            );
        }
        let audio_path = PathBuf::from(
            std::env::var_os("ORION_ELEVENLABS_LIVE_QA_AUDIO_PATH").ok_or(
                "Set ORION_ELEVENLABS_LIVE_QA_AUDIO_PATH to a new absolute .mp3 output path.",
            )?,
        );
        if !audio_path.is_absolute()
            || audio_path.extension().and_then(|s| s.to_str()) != Some("mp3")
            || audio_path.exists()
        {
            return Err("The live probe requires a new absolute .mp3 output path; existing files are never replaced.".into());
        }
        let parent = audio_path
            .parent()
            .filter(|p| p.is_dir())
            .ok_or("The QA output directory must already exist.")?;
        // Reserve a writable local temporary file before any paid request. Publish only
        // complete validated audio; a failed probe never leaves a zero-byte final MP3.
        let mut audio_file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Could not prepare the QA audio output.")?;
        let voice_id = std::env::var("ORION_ELEVENLABS_LIVE_QA_VOICE_ID")
            .unwrap_or_else(|_| ELEVENLABS_DEFAULT_VOICE_ID.to_string());
        explicit_voice_id(&voice_id)?;
        let model_id = validate_model_id(
            std::env::var("ORION_ELEVENLABS_LIVE_QA_MODEL_ID")
                .ok()
                .as_deref(),
        )?;
        const TEXT: &str =
            "Hello. This is a short Orion voice preview, checking that narration is working.";
        let client =
            provider_http_client().map_err(|_| "Could not prepare the provider HTTP client.")?;
        let api_key = key().await?;
        println!("elevenlabs_live credentials_ready=true");

        let started = std::time::Instant::now();
        let library = request_voice_library(&client, api_key.as_str(), None).await?;
        let voice_count = library["voices"]
            .as_array()
            .ok_or("Invalid parsed voice catalog.")?
            .len();
        println!("elevenlabs_live library_ok=true voices_on_first_page={voice_count} has_more={} elapsed_ms={}", !library["nextPage"].is_null(), started.elapsed().as_millis());

        let started = std::time::Instant::now();
        let models = request_voice_models(&client, api_key.as_str()).await?;
        let models = models.as_array().ok_or("Invalid parsed model catalog.")?;
        if !models.iter().any(|model| model["id"] == model_id) {
            return Err("The selected speech model is not in the account's speech model catalog; no preview requested.".into());
        }
        println!(
            "elevenlabs_live models_ok=true speech_models={} elapsed_ms={}",
            models.len(),
            started.elapsed().as_millis()
        );

        let started = std::time::Instant::now();
        let voice = request_voice(&client, api_key.as_str(), &voice_id).await?;
        if voice["requiresVerification"] == true {
            return Err("The selected voice requires verification; no preview requested.".into());
        }
        let controls: VoiceSettings = serde_json::from_value(voice["settings"].clone())
            .map_err(|_| "The selected voice returned invalid normalized settings.")?;
        println!(
            "elevenlabs_live voice_read_ok=true elapsed_ms={}",
            started.elapsed().as_millis()
        );

        let started = std::time::Instant::now();
        // Exactly one preview POST. Failures are returned; there is no retry/fallback.
        let preview = request_voice_preview(
            &client,
            api_key.as_str(),
            &voice_id,
            &model_id,
            TEXT,
            &controls,
        )
        .await?;
        let bytes = BASE64_STANDARD
            .decode(
                preview["audio"]
                    .as_str()
                    .ok_or("Preview did not contain encoded audio.")?,
            )
            .map_err(|_| "Preview audio encoding was invalid.")?;
        std::io::Write::write_all(&mut audio_file, &bytes)
            .map_err(|_| "Could not write the completed QA audio.")?;
        audio_file
            .as_file()
            .sync_all()
            .map_err(|_| "Could not flush the completed QA audio.")?;
        audio_file.persist_noclobber(&audio_path).map_err(|_| {
            "Could not publish the completed QA audio without replacing an existing file."
        })?;
        println!("elevenlabs_live preview_ok=true preview_requests=1 text_characters={} audio_bytes={} elapsed_ms={}", TEXT.chars().count(), bytes.len(), started.elapsed().as_millis());
        Ok(())
    }
}
