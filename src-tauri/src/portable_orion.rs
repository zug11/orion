//! A bounded, versioned collection format, never a serialized vault. Native
//! dialog/Finder grants choose files; opaque content-addressed images cannot
//! overwrite attachments already referenced by another Space.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Collection {
    title: String,
    notes: Vec<Note>,
    sources: Vec<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket_codes: Option<Value>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Note {
    id: String,
    title: String,
    summary: String,
    body: String,
    tags: Vec<String>,
    source_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_layout: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    id: String,
    title: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    id: String,
    mime_type: String,
    base64_data: String,
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
fn validate(package: &Package, require_assets: bool) -> Result<(), String> {
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
    let mut asset_bytes = 0;
    for asset in &package.assets {
        if !id(&asset.id, 12, 80)
            || !asset_ids.insert(asset.id.clone())
            || !references.contains(&asset.id)
            || asset.base64_data.len() > 16 * 1024 * 1024
        {
            return Err("Invalid, duplicated or unreferenced collection attachment.".into());
        }
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
        asset_bytes += bytes.len();
    }
    if require_assets && references != asset_ids {
        return Err("An attachment referenced by this collection is missing.".into());
    }
    if asset_bytes + body_bytes > 90 * 1024 * 1024 {
        return Err("This collection exceeds the portable file size limit.".into());
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
pub(crate) fn receive(app: &AppHandle, urls: Vec<reqwest::Url>) {
    let state = app.state::<PendingFiles>();
    let Ok(mut pending) = state.0.lock() else {
        return;
    };
    for url in urls {
        if let Ok(path) = url.to_file_path() {
            if path
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("orion"))
                && pending.len() < 32
                && !pending.iter().any(|(_, p)| p == &path)
            {
                pending.push_back((uuid::Uuid::new_v4().to_string(), path));
            }
        }
    }
    let has_files = !pending.is_empty();
    drop(pending);
    if !has_files {
        return;
    }
    let _ = app.emit("orion-portable-files", ());
    if crate::desktop_windows::preferred_library_window(app).is_none() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::desktop_windows::ensure_library_window(app).await;
        });
    }
    if let Some(window) = crate::desktop_windows::preferred_window(app) {
        let _ = window.show();
        let _ = window.set_focus();
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
pub(crate) struct OpenedPackage {
    file: Package,
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
    validate(&file, true)?;
    // serde_json's Value object keys are sorted, matching the browser canonicalizer.
    let digest = serde_json::to_vec(&json!({"collection":file.collection,"assets":file.assets}))
        .map_err(|_| "Could not identify this collection.")?;
    let collection_hash = format!("{:x}", Sha256::digest(&digest));
    let mut image_urls = BTreeMap::new();
    // Every asset was decoded and validated before the first attachment is staged.
    for asset in &file.assets {
        let bytes = STANDARD
            .decode(&asset.base64_data)
            .map_err(|_| "Invalid attachment encoding.")?;
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
        image_urls.insert(asset.id.clone(), format!("orion-image://localhost/{id}"));
    }
    Ok(OpenedPackage {
        file,
        collection_hash,
        image_urls,
    })
}
#[tauri::command]
pub(crate) async fn open_orion_file(
    app: AppHandle,
    token: Option<String>,
) -> Result<Option<OpenedPackage>, String> {
    let path = if let Some(token) = token {
        let state = app.state::<PendingFiles>();
        let mut queue = state
            .0
            .lock()
            .map_err(|_| "The file-open queue was interrupted.")?;
        let position = queue
            .iter()
            .position(|(id, _)| id == &token)
            .ok_or("This file-open request expired. Open the file again.")?;
        queue.remove(position).unwrap().1
    } else {
        let selected = app
            .dialog()
            .file()
            .set_title("Open Orion collection")
            .add_filter("Orion collection", &["orion"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        crate::selected_export_path(selected)?
    };
    let images = crate::note_image_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || open_file(&path, &images).map(Some))
        .await
        .map_err(|e| format!("The collection could not be opened: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let bytes = STANDARD.decode(&opened.file.assets[0].base64_data).unwrap();
        assert_eq!(
            crate::read_note_image(images.path(), asset_id).unwrap().0,
            bytes
        );
        let again = open_file(&path, images.path()).unwrap();
        assert_eq!(again.image_urls, opened.image_urls);
        assert_eq!(fs::read_dir(images.path()).unwrap().count(), 1);
        // Managed content can be repackaged without reading a code-example image.
        let mut repack = opened.file.clone();
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
        let mut invalid = opened.file.clone();
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
