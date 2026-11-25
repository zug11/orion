//! A bounded, versioned collection format, never a serialized vault. Native
//! dialog/Finder grants choose files; opaque content-addressed images cannot
//! overwrite attachments already referenced by another Space.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;

const MAX_FILE: usize = 128 * 1024 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Package {
    format: String,
    version: u32,
    export_id: String,
    entry_note_id: String,
    collection: Collection,
    assets: Vec<Asset>,
}
// These wire structs are serialized directly into the content hash. Keep fields
// in lexical order of their JSON names, matching the browser canonicalizer.
// The empty/optional fields follow the same serialization rules on export.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Collection {
    notes: Vec<Note>,
    sources: Vec<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket_codes: Option<Value>,
    title: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Note {
    body: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_contact"
    )]
    contact: Option<crate::contact::Contact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_layout: Option<String>,
    id: String,
    source_ids: Vec<String>,
    summary: String,
    tags: Vec<String>,
    title: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_writing_origins"
    )]
    writing_origins: Option<Value>,
}

fn deserialize_contact<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<crate::contact::Contact>, D::Error> {
    crate::contact::parse(&Value::deserialize(input)?)
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("Invalid contact metadata."))
}

fn deserialize_writing_origins<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<Value>, D::Error> {
    let value = Value::deserialize(input)?;
    if crate::writing_origins::is_valid(&value) {
        Ok(Some(value))
    } else {
        Err(serde::de::Error::custom("Invalid note writing origins."))
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    title: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    base64_data: String,
    id: String,
    mime_type: String,
}

fn collection_hash(package: &Package) -> Result<String, String> {
    #[derive(Serialize)]
    struct Content<'a> {
        assets: &'a [Asset],
        collection: &'a Collection,
    }
    let mut digest = Sha256::new();
    serde_json::to_writer(
        &mut digest,
        &Content {
            assets: &package.assets,
            collection: &package.collection,
        },
    )
    .map_err(|error| format!("Could not identify this collection: {error}"))?;
    Ok(format!("{:x}", digest.finalize()))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportWorkflow {
    job_id: String,
    session_id: String,
}
fn id(value: &str, min: usize, max: usize) -> bool {
    value.len() >= min
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn image_ids(collection: &Collection) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for note in &collection.notes {
        if !note.body.contains("![") {
            continue;
        }
        for event in Parser::new_ext(&note.body, Options::all()) {
            if let Event::Start(Tag::Image { dest_url, .. }) = event {
                if let Some(value) = dest_url.strip_prefix("orion-image://localhost/") {
                    if id(value, 12, 80) {
                        ids.insert(value.to_owned());
                    }
                }
            }
        }
    }
    ids
}
fn validate_manifest(package: &Package, require_assets: bool) -> Result<usize, String> {
    if package.format != "orion"
        || package.version != 1
        || !id(&package.export_id, 16, 64)
        || !id(&package.entry_note_id, 1, 96)
        || package.collection.title.len() > 2000
        || package.collection.notes.is_empty()
        || package.collection.notes.len() > 200
        || package.collection.sources.len() > 2000
        || package.assets.len() > 1000
    {
        return Err("Unsupported .orion collection format or size.".into());
    }
    let mut note_ids = BTreeSet::new();
    let mut body_bytes = 0;
    for note in &package.collection.notes {
        if !id(&note.id, 1, 96)
            || !note_ids.insert(&note.id)
            || note.title.chars().count() > 2000
            || note.summary.chars().count() > 100_000
            || note.body.len() > 8 * 1024 * 1024
            || note.tags.len() > 500
            || note.tags.iter().any(|tag| tag.chars().count() > 500)
            || note.source_ids.len() > 2000
            || note
                .heading_layout
                .as_ref()
                .is_some_and(|v| !matches!(v.as_str(), "both" | "title" | "subtitle" | "none"))
        {
            return Err("Invalid or duplicate note in this .orion collection.".into());
        }
        body_bytes += note.body.len();
    }
    if !note_ids.contains(&package.entry_note_id) || body_bytes > MAX_BODY {
        return Err("The designated note is missing or this collection is too large.".into());
    }
    let mut source_ids = BTreeSet::new();
    for source in &package.collection.sources {
        if !id(&source.id, 1, 96)
            || !source_ids.insert(&source.id)
            || source.title.chars().count() > 2000
            || !matches!(
                source.kind.as_str(),
                "manual"
                    | "text"
                    | "markdown"
                    | "json"
                    | "csv"
                    | "html"
                    | "pdf"
                    | "docx"
                    | "image"
                    | "audio"
                    | "video"
                    | "youtube"
            )
        {
            return Err("Invalid source attribution in this collection.".into());
        }
        if let Some(raw) = &source.source_url {
            let url = reqwest::Url::parse(raw).map_err(|_| "Invalid source URL.")?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Only public web URLs can accompany source attribution.".into());
            }
        }
    }
    if package
        .collection
        .notes
        .iter()
        .any(|n| n.source_ids.iter().any(|id| !source_ids.contains(id)))
    {
        return Err("A note refers to missing source attribution.".into());
    }
    if let Some(codes) = &package.collection.ticket_codes {
        crate::ticket_codes::validate(codes).map_err(|_| {
            "Ticket codes collide or are invalid. Export a fresh collection to resolve them."
        })?;
    }
    let references = image_ids(&package.collection);
    let mut asset_ids = BTreeSet::new();
    for asset in &package.assets {
        if !id(&asset.id, 12, 80)
            || !asset_ids.insert(asset.id.clone())
            || !references.contains(&asset.id)
            || asset.base64_data.len() > 16 * 1024 * 1024
        {
            return Err("Invalid, duplicated or unreferenced collection attachment.".into());
        }
    }
    if require_assets && references != asset_ids {
        return Err("An attachment referenced by this collection is missing.".into());
    }
    Ok(body_bytes)
}

fn decode_asset(asset: &Asset, total_bytes: &mut usize) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(&asset.base64_data)
        .map_err(|_| "An attachment is not valid base64.")?;
    if bytes.is_empty() || bytes.len() > crate::MAX_NOTE_IMAGE_BYTES {
        return Err("An attachment exceeds the 12 MB image limit.".into());
    }
    let (_, mime) = crate::note_image_kind_from_bytes(&bytes)
        .ok_or("An attachment is not a supported raster image.")?;
    if mime != asset.mime_type {
        return Err("An attachment's contents do not match its type.".into());
    }
    *total_bytes += bytes.len();
    if *total_bytes > 90 * 1024 * 1024 {
        return Err("This collection exceeds the portable file size limit.".into());
    }
    Ok(bytes)
}

fn validate(package: &Package, require_assets: bool) -> Result<(), String> {
    let mut total_bytes = validate_manifest(package, require_assets)?;
    for asset in &package.assets {
        decode_asset(asset, &mut total_bytes)?;
    }
    Ok(())
}

fn populate_assets(package: &mut Package, directory: &Path) -> Result<(), String> {
    validate(package, false)?;
    for id in image_ids(&package.collection) {
        if !package.assets.iter().any(|a| a.id == id) {
            let (bytes, mime, _) = crate::read_note_image(directory, &id)?;
            package.assets.push(Asset {
                id,
                mime_type: mime.into(),
                base64_data: STANDARD.encode(bytes),
            });
        }
    }
    validate(package, true)
}
fn encode(package: &Package) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(package).map_err(|_| "Could not encode this collection.")?;
    if bytes.len() > MAX_FILE {
        return Err("This .orion file would exceed 128 MB. Export fewer notes or images.".into());
    }
    Ok(bytes)
}
fn write_collection(package: &Package, directory: &Path) -> Result<u32, String> {
    let size = encode(package)?.len();
    if size.saturating_mul(package.collection.notes.len()) > 2 * 1024 * 1024 * 1024 {
        return Err(
            "These per-note copies would exceed 2 GB. Export fewer notes or images.".into(),
        );
    }
    // Prepare every file before publishing any. No existing file is replaced.
    let mut prepared = Vec::new();
    for note in &package.collection.notes {
        let mut copy = package.clone();
        copy.entry_note_id = note.id.clone();
        let bytes = encode(&copy)?;
        let mut temporary = NamedTempFile::new_in(directory)
            .map_err(|e| format!("Could not prepare the export: {e}"))?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|e| format!("Could not secure the export: {e}"))?;
        prepared.push((temporary, crate::safe_file_stem(&note.title)));
    }
    let mut written = Vec::new();
    for (mut temporary, stem) in prepared {
        let mut suffix = 0;
        loop {
            let name = if suffix == 0 {
                format!("{stem}.orion")
            } else {
                format!("{stem}-{suffix}.orion")
            };
            let path = directory.join(name);
            match temporary.persist_noclobber(&path) {
                Ok(_) => {
                    written.push(path);
                    break;
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    temporary = error.file;
                    suffix += 1;
                    if suffix > 10_000 {
                        return Err("Too many existing files have this name.".into());
                    }
                }
                Err(error) => {
                    for path in written {
                        let _ = fs::remove_file(path);
                    }
                    return Err(format!(
                        "The collection could not be saved: {}",
                        error.error
                    ));
                }
            }
        }
    }
    crate::sync_directory(directory)?;
    Ok(package.collection.notes.len() as u32)
}
fn check_workflow(
    app: &AppHandle,
    workflow: Option<&ExportWorkflow>,
    file: &Package,
) -> Result<(), String> {
    if let Some(workflow) = workflow {
        let request = app
            .state::<crate::assistant_bridge::AssistantBridge>()
            .assert_running(&workflow.job_id, &workflow.session_id)?;
        if request.operation != crate::assistant_protocol::Operation::Export
            || request.input["format"] != "orion"
        {
            return Err("This workflow is not an Orion collection export.".into());
        }
        let expected = request.input["note_ids"]
            .as_array()
            .ok_or("Choose exact notes for this collection export.")?;
        let ids: BTreeSet<_> = file
            .collection
            .notes
            .iter()
            .map(|n| n.id.as_str())
            .collect();
        if ids != expected.iter().filter_map(Value::as_str).collect() {
            return Err("The export selection changed after the workflow was authorized.".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn export_orion_files(
    app: AppHandle,
    mut file: Package,
    workflow: Option<ExportWorkflow>,
) -> Result<crate::ExportResult, String> {
    validate(&file, false)?;
    check_workflow(&app, workflow.as_ref(), &file)?;
    let selected = app
        .dialog()
        .file()
        .set_title("Export Orion collection files")
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(crate::ExportResult {
            exported_count: 0,
            directory: String::new(),
            cancelled: true,
        });
    };
    let directory = crate::selected_directory(selected)?;
    let assets = crate::note_image_directory(&app)?;
    let destination = directory.to_string_lossy().into_owned();
    let count = tauri::async_runtime::spawn_blocking(move || {
        populate_assets(&mut file, &assets)?;
        check_workflow(&app, workflow.as_ref(), &file)?;
        if let Some(w) = &workflow {
            app.state::<crate::assistant_bridge::AssistantBridge>()
                .begin_export_commit(&w.job_id, &w.session_id)?;
        }
        let result = write_collection(&file, &directory);
        if let Some(w) = &workflow {
            app.state::<crate::assistant_bridge::AssistantBridge>()
                .finish_export_commit(
                    &w.job_id,
                    &w.session_id,
                    result
                        .as_ref()
                        .map(|_| directory.to_string_lossy().into_owned())
                        .map_err(Clone::clone),
                )?;
        }
        result
    })
    .await
    .map_err(|e| format!("The collection export stopped: {e}"))??;
    Ok(crate::ExportResult {
        exported_count: count,
        directory: destination,
        cancelled: false,
    })
}

#[derive(Default)]
pub(crate) struct PendingFiles(Mutex<VecDeque<(String, PathBuf)>>);
impl PendingFiles {
    fn enqueue(&self, paths: impl IntoIterator<Item = PathBuf>) -> Result<bool, String> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| "The file-open queue was interrupted.")?;
        let mut accepted = false;
        for path in paths {
            if !path
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("orion"))
            {
                continue;
            }
            if pending.iter().any(|(_, queued)| *queued == path) {
                accepted = true;
            } else if pending.len() < 32 {
                pending.push_back((uuid::Uuid::new_v4().to_string(), path));
                accepted = true;
            }
        }
        Ok(accepted)
    }

    fn claim(&self, token: &str) -> Result<Option<PathBuf>, String> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| "The file-open queue was interrupted.")?;
        let Some(position) = pending.iter().position(|(id, _)| id == token) else {
            // Another library window can have drained the same queue snapshot.
            return Ok(None);
        };
        Ok(pending.remove(position).map(|(_, path)| path))
    }
}

async fn show_pending_files(app: AppHandle) -> Result<(), String> {
    if let Err(error) = crate::desktop_windows::ensure_library_window(app.clone()).await {
        // A window that macOS declined to raise can still open its document.
        if crate::desktop_windows::preferred_library_window(&app).is_none() {
            return Err(error);
        }
    }
    app.emit("orion-portable-files", ())
        .map_err(|error| error.to_string())
}

pub(crate) fn receive(app: &AppHandle, urls: Vec<reqwest::Url>) {
    let paths = urls.into_iter().filter_map(|url| url.to_file_path().ok());
    if app.state::<PendingFiles>().enqueue(paths).unwrap_or(false) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = show_pending_files(app).await;
        });
    }
}
#[tauri::command]
pub(crate) fn pending_orion_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    if crate::desktop_windows::preferred_library_window(&app)
        .is_some_and(|owner| owner.label() != window.label())
    {
        return Ok(vec![]);
    }
    Ok(app
        .state::<PendingFiles>()
        .0
        .lock()
        .map_err(|_| "The file-open queue was interrupted.")?
        .iter()
        .map(|(id, _)| id.clone())
        .collect())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedDocument {
    export_id: String,
    entry_note_id: String,
    collection: Collection,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedPackage {
    file: OpenedDocument,
    collection_hash: String,
    image_urls: BTreeMap<String, String>,
}
fn open_file(path: &Path, images: &Path) -> Result<OpenedPackage, String> {
    if !path
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("orion"))
    {
        return Err("Choose an .orion collection file.".into());
    }
    let input = File::open(path).map_err(|e| format!("Could not open the collection: {e}"))?;
    if input
        .metadata()
        .map_err(|_| "Could not inspect this file.")?
        .len()
        > MAX_FILE as u64
    {
        return Err("This .orion file is larger than 128 MB.".into());
    }
    let mut bytes = Vec::new();
    input
        .take((MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read the collection: {e}"))?;
    if bytes.len() > MAX_FILE {
        return Err("This .orion file is larger than 128 MB.".into());
    }
    let file: Package = serde_json::from_slice(&bytes)
        .map_err(|e| format!("This .orion file is invalid or uses an unsupported version: {e}"))?;
    drop(bytes);
    let mut total_bytes = validate_manifest(&file, true)?;
    let collection_hash = collection_hash(&file)?;
    // Release each encoded string as its checked bytes replace it. No image
    // is written until every image has passed all format and size checks.
    let mut decoded = Vec::with_capacity(file.assets.len());
    for asset in file.assets {
        let bytes = decode_asset(&asset, &mut total_bytes)?;
        decoded.push((asset.id, bytes));
    }
    let mut image_urls = BTreeMap::new();
    for (asset_id, bytes) in decoded {
        let id = format!("portable-{:x}", Sha256::digest(&bytes));
        let path = images.join(&id);
        if path.exists() {
            let (existing, _, _) = crate::read_note_image(images, &id)?;
            if existing != bytes {
                return Err(
                    "An attachment identity collision was detected. Existing images were kept."
                        .into(),
                );
            }
        } else if let Err(error) = crate::persist_note_image(&path, &bytes) {
            if !path.exists() || crate::read_note_image(images, &id)?.0 != bytes {
                return Err(error);
            }
        }
        image_urls.insert(asset_id, format!("orion-image://localhost/{id}"));
    }
    Ok(OpenedPackage {
        file: OpenedDocument {
            export_id: file.export_id,
            entry_note_id: file.entry_note_id,
            collection: file.collection,
        },
        collection_hash,
        image_urls,
    })
}
fn pick_collection_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    app.dialog()
        .file()
        .set_title("Open Orion collection")
        .add_filter("Orion collection", &["orion"])
        .blocking_pick_file()
        .map(crate::selected_export_path)
        .transpose()
}

#[tauri::command]
pub(crate) async fn pick_orion_file_for_library(app: AppHandle) -> Result<bool, String> {
    let Some(path) = pick_collection_path(&app)? else {
        return Ok(false);
    };
    if !app.state::<PendingFiles>().enqueue([path])? {
        return Err(
            "Orion could not queue this collection. Finish opening the queued files and try again."
                .into(),
        );
    }
    show_pending_files(app).await?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn open_orion_file(
    app: AppHandle,
    token: Option<String>,
) -> Result<Option<OpenedPackage>, String> {
    let path = if let Some(token) = token {
        let Some(path) = app.state::<PendingFiles>().claim(&token)? else {
            return Ok(None);
        };
        path
    } else {
        let Some(path) = pick_collection_path(&app)? else {
            return Ok(None);
        };
        path
    };
    let images = crate::note_image_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || open_file(&path, &images).map(Some))
        .await
        .map_err(|e| format!("The collection could not be opened: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn overlapping_library_drains_claim_a_finder_request_only_once() {
        let pending = PendingFiles::default();
        let path = PathBuf::from("Selected note.orion");
        pending.enqueue([path.clone()]).unwrap();
        let token = pending.0.lock().unwrap().front().unwrap().0.clone();
        assert_eq!(pending.claim(&token).unwrap(), Some(path));
        assert_eq!(pending.claim(&token).unwrap(), None);
    }
    #[test]
    fn finder_and_the_writing_picker_share_one_bounded_file_queue() {
        let pending = PendingFiles::default();
        assert!(!pending.enqueue([PathBuf::from("other.txt")]).unwrap());
        for n in 0..32 {
            assert!(pending
                .enqueue([PathBuf::from(format!("{n}.orion"))])
                .unwrap());
        }
        assert!(pending.enqueue([PathBuf::from("0.orion")]).unwrap());
        assert!(!pending.enqueue([PathBuf::from("extra.orion")]).unwrap());
        assert_eq!(pending.0.lock().unwrap().len(), 32);
    }
    #[test]
    fn streamed_hash_matches_sorted_wire_json_with_all_optional_fields() {
        let raw = include_str!("../tests/fixtures/portable-collection.orion");
        let mut file: Package = serde_json::from_str(raw).unwrap();
        file.collection.notes[0].heading_layout = Some("title".into());
        file.collection.notes[0].writing_origins = Some(json!(["orion-ai", "mcp"]));
        file.collection.notes[0].source_ids.push("src".into());
        file.collection.sources.push(Source {
            id: "src".into(),
            kind: "text".into(),
            source_url: Some("https://example.com/notes".into()),
            title: "Source".into(),
        });
        let sorted = json!({"collection":file.collection,"assets":file.assets});
        let expected = Sha256::digest(serde_json::to_vec(&sorted).unwrap());
        assert_eq!(collection_hash(&file).unwrap(), format!("{expected:x}"));
    }

    #[test]
    fn portable_contact_round_trips_with_browser_hash() {
        let mut wire: Value =
            serde_json::from_str(include_str!("../tests/fixtures/portable-collection.orion"))
                .unwrap();
        wire["collection"]["notes"][0]["contact"] =
            json!({"version": 1, "organization": "Lua Studio"});
        let package: Package = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            collection_hash(&package).unwrap(),
            "04b795ce8ac96533c223663e08b993412951fe8fefd6e0fcf2d94fbee498c6c7"
        );
        assert_eq!(serde_json::to_value(package).unwrap(), wire);
        wire["collection"]["notes"][0]["contact"] = Value::Null;
        assert!(serde_json::from_value::<Package>(wire).is_err());
    }

    #[test]
    fn writing_origins_round_trip_with_browser_hash_and_reject_invalid_metadata() {
        let raw = include_str!("../tests/fixtures/portable-collection.orion");
        let mut wire: Value = serde_json::from_str(raw).unwrap();
        wire["collection"]["notes"][0]["writingOrigins"] = json!(["orion-ai", "mcp"]);
        let package: Package = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            collection_hash(&package).unwrap(),
            "3510704b4d4ef228c4b8e95cdba28f8ecdce2ab35082cdce48ba60c3a3818c45"
        );
        assert_eq!(serde_json::to_value(package).unwrap(), wire);
        for invalid in [
            json!([]),
            json!(null),
            json!(["mcp", "orion-ai"]),
            json!(["human"]),
        ] {
            wire["collection"]["notes"][0]["writingOrigins"] = invalid;
            assert!(serde_json::from_value::<Package>(wire.clone()).is_err());
        }
    }

    #[test]
    fn image_roundtrip_matches_browser_identity_and_validates_every_asset_before_staging() {
        let raw = include_str!("../tests/fixtures/portable-collection.orion");
        let directory = tempfile::tempdir().unwrap();
        let images = tempfile::tempdir().unwrap();
        let path = directory.path().join("shared.orion");
        fs::write(&path, raw).unwrap();
        let opened = open_file(&path, images.path()).unwrap();
        assert_eq!(
            opened.collection_hash,
            "9fb4d785761795ade427cdc4f29c2b0a3242f5bfe9a5c76a4c2a14ebf1f6a055"
        );
        let url = &opened.image_urls["picture_fixture_2026"];
        let asset_id = url.strip_prefix("orion-image://localhost/").unwrap();
        let package: Package = serde_json::from_str(raw).unwrap();
        let bytes = STANDARD.decode(&package.assets[0].base64_data).unwrap();
        let response = serde_json::to_value(&opened).unwrap();
        assert!(response["file"].get("assets").is_none());
        assert!(!response
            .to_string()
            .contains(&package.assets[0].base64_data));
        assert_eq!(
            crate::read_note_image(images.path(), asset_id).unwrap().0,
            bytes
        );
        let again = open_file(&path, images.path()).unwrap();
        assert_eq!(again.image_urls, opened.image_urls);
        assert_eq!(fs::read_dir(images.path()).unwrap().count(), 1);
        // Managed content can be repackaged without reading a code-example image.
        let mut repack = package.clone();
        repack.collection.notes[0].body =
            format!("![Picture]({url})\n\n`![private](orion-image://localhost/private_1234567)`");
        repack.assets.clear();
        populate_assets(&mut repack, images.path()).unwrap();
        assert_eq!(repack.assets.len(), 1);
        assert_eq!(
            STANDARD.decode(&repack.assets[0].base64_data).unwrap(),
            bytes
        );
        let untouched = tempfile::tempdir().unwrap();
        let mut invalid = package;
        invalid.collection.notes[1]
            .body
            .push_str("\n\n![bad](orion-image://localhost/invalid_picture_2026)");
        invalid.assets.push(Asset {
            id: "invalid_picture_2026".into(),
            mime_type: "image/png".into(),
            base64_data: STANDARD.encode(b"not an image"),
        });
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(open_file(&path, untouched.path()).is_err());
        assert_eq!(fs::read_dir(untouched.path()).unwrap().count(), 0);
    }
    fn package() -> Package {
        serde_json::from_value(json!({"format":"orion","version":1,"exportId":"collection_1234567890","entryNoteId":"n1","collection":{"title":"Shared","notes":[{"id":"n1","title":"One","summary":"","body":"[Two](orion-note://n2)","tags":[],"sourceIds":[]},{"id":"n2","title":"Two","summary":"","body":"A note","tags":[],"sourceIds":[]}],"sources":[]},"assets":[]})).unwrap()
    }
    #[test]
    fn per_note_files_share_identity_and_content_and_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let images = tempfile::tempdir().unwrap();
        let p = package();
        assert_eq!(write_collection(&p, dir.path()).unwrap(), 2);
        let a = open_file(&dir.path().join("One.orion"), images.path()).unwrap();
        let b = open_file(&dir.path().join("Two.orion"), images.path()).unwrap();
        assert_eq!(a.collection_hash, b.collection_hash);
        assert_eq!(a.file.export_id, b.file.export_id);
        assert_eq!(a.file.entry_note_id, "n1");
        assert_eq!(b.file.entry_note_id, "n2");
        assert_eq!(a.file.collection.notes.len(), 2);
        write_collection(&p, dir.path()).unwrap();
        assert!(dir.path().join("One-1.orion").exists());
        let mut invalid = serde_json::to_value(&p).unwrap();
        invalid["collection"]["settings"] = json!({"key":"private"});
        assert!(serde_json::from_value::<Package>(invalid).is_err());
    }
    #[test]
    fn rejects_missing_unreferenced_unsafe_and_colliding_content_before_staging() {
        let mut p = package();
        p.collection.notes[0].body = "![picture](orion-image://localhost/picture_123456789)".into();
        assert!(validate(&p, true).is_err());
        p = package();
        p.assets.push(Asset {
            id: "../outside12345".into(),
            mime_type: "image/png".into(),
            base64_data: "aGVsbG8=".into(),
        });
        assert!(validate(&p, true).is_err());
        p = package();
        p.collection.notes[1].id = "n1".into();
        assert!(validate(&p, true).is_err());
        p = package();
        p.collection.ticket_codes =
            Some(json!({"version":1,"prefix":"ORION","nextNumber":2,"assigned":{"a":1,"b":1}}));
        assert!(validate(&p, true).is_err());
        p = package();
        p.collection.notes[0].body = "`![private](orion-image://localhost/private_1234567)`".into();
        assert!(image_ids(&p.collection).is_empty());
    }
}
