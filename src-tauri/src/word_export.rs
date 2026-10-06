//! Explicit local Word export. The renderer supplies document content, never a path.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{Cursor, Read, Write},
    path::Path,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;
use zeroize::Zeroizing;

const MAX_DOCUMENT_BYTES: usize = 128 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const WORD_NAMESPACE: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NAMESPACE: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const MAIN_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WordExportRequest {
    file_name: String,
    base64_data: String,
    workflow: Option<ExportWorkflow>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportWorkflow {
    job_id: String,
    session_id: String,
}

fn check_workflow(app: &AppHandle, workflow: Option<&ExportWorkflow>) -> Result<(), String> {
    if let Some(workflow) = workflow {
        let request = app
            .state::<crate::assistant_bridge::AssistantBridge>()
            .assert_running(&workflow.job_id, &workflow.session_id)?;
        if request.operation != crate::assistant_protocol::Operation::Export {
            return Err("This assistant job is not authorized to export a document.".into());
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct WordExportResult {
    path: String,
    cancelled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WordExportImage {
    base64_data: String,
    mime_type: &'static str,
}

/// Reads only an existing opaque attachment ID through Orion's canonical,
/// bounded raster resolver; no arbitrary path or network access is accepted.
#[tauri::command]
pub(crate) async fn read_word_export_image(
    app: AppHandle,
    asset_id: String,
) -> Result<WordExportImage, String> {
    let directory = crate::note_image_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, mime_type, _) = crate::read_note_image(&directory, &asset_id)?;
        Ok(WordExportImage {
            base64_data: STANDARD.encode(bytes),
            mime_type,
        })
    })
    .await
    .map_err(|error| format!("Orion could not read the export image: {error}"))?
}

fn decode(request: &WordExportRequest) -> Result<Zeroizing<Vec<u8>>, String> {
    if request.file_name.trim().is_empty()
        || request.file_name.chars().count() > 240
        || request.file_name.chars().any(char::is_control)
        || request.base64_data.is_empty()
        || request.base64_data.len() > MAX_DOCUMENT_BYTES.div_ceil(3) * 4
    {
        return Err("The Word export is empty, invalid, or too large.".into());
    }
    let bytes = Zeroizing::new(
        STANDARD
            .decode(&request.base64_data)
            .map_err(|_| "The Word export contains invalid document data.".to_string())?,
    );
    validate_package(&bytes)?;
    Ok(bytes)
}

fn validate_relationship(kind: &str, target: &str, mode: &str) -> Result<(), String> {
    let invalid =
        || "The Word document contains an unsupported or unsafe relationship.".to_string();
    let known = kind.strip_prefix("http://schemas.openxmlformats.org/officeDocument/2006/relationships/")
        .is_some_and(|suffix| ["officeDocument", "styles", "numbering", "settings", "webSettings", "theme", "fontTable", "footnotes", "endnotes", "comments", "image", "hyperlink", "extended-properties", "custom-properties"].contains(&suffix))
        || kind == "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
    if !known || target.is_empty() {
        return Err(invalid());
    }
    if mode == "External" {
        if !kind.ends_with("/hyperlink") {
            return Err(invalid());
        }
        let url = reqwest::Url::parse(target).map_err(|_| invalid())?;
        if !["https", "http", "mailto"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(invalid());
        }
    } else if !["", "Internal"].contains(&mode)
        || target.starts_with('/')
        || target.contains(['\\', ':', '\0'])
        || target.split('/').any(|part| part == ".." || part == ".")
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_xml(name: &str, xml: &str) -> Result<(), String> {
    let invalid = || "Orion received invalid or active Word document XML.".to_string();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    reader.config_mut().expand_empty_elements = true;
    let mut first = true;
    let mut depth: usize = 0;
    let mut root_closed = false;
    let mut body = false;
    let mut main_type = false;
    let mut document_relationship = false;
    loop {
        match reader.read_event().map_err(|_| invalid())? {
            Event::Start(element) | Event::Empty(element) => {
                if root_closed {
                    return Err(invalid());
                }
                let tag = element.local_name();
                let local = std::str::from_utf8(tag.as_ref()).map_err(|_| invalid())?;
                if [
                    "instrText",
                    "fldSimple",
                    "altChunk",
                    "object",
                    "control",
                    "attachedTemplate",
                    "OLEObject",
                ]
                .contains(&local)
                {
                    return Err(invalid());
                }
                let attributes = element
                    .attributes()
                    .map(|attribute| {
                        let attribute = attribute.map_err(|_| invalid())?;
                        Ok::<_, String>((
                            String::from_utf8(attribute.key.as_ref().to_vec())
                                .map_err(|_| invalid())?,
                            attribute
                                .decode_and_unescape_value(reader.decoder())
                                .map_err(|_| invalid())?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
                let value = |key: &str| attributes.get(key).map(String::as_str).unwrap_or("");
                if first {
                    if name.ends_with(".rels") && (local != "Relationships" || value("xmlns") != REL_NAMESPACE)
                        || name == "[Content_Types].xml" && (local != "Types" || value("xmlns") != "http://schemas.openxmlformats.org/package/2006/content-types")
                        || name == "word/document.xml" && (element.name().as_ref() != b"w:document" || value("xmlns:w") != WORD_NAMESPACE) { return Err(invalid()); }
                    first = false;
                }
                if name.ends_with(".rels") && local == "Relationship" {
                    validate_relationship(value("Type"), value("Target"), value("TargetMode"))?;
                    if name == "_rels/.rels"
                        && value("Type").ends_with("/officeDocument")
                        && value("Target") == "word/document.xml"
                        && value("TargetMode") != "External"
                    {
                        document_relationship = true;
                    }
                }
                if name == "[Content_Types].xml" {
                    let content_type = value("ContentType").to_ascii_lowercase();
                    if ["macroenabled", "vba", "activex", "oleobject"]
                        .iter()
                        .any(|term| content_type.contains(term))
                    {
                        return Err(invalid());
                    }
                    if local == "Override"
                        && value("PartName") == "/word/document.xml"
                        && value("ContentType") == MAIN_CONTENT_TYPE
                    {
                        main_type = true;
                    }
                }
                if name == "word/document.xml" && element.name().as_ref() == b"w:body" {
                    body = true;
                }
                depth += 1;
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or_else(invalid)?;
                if depth == 0 {
                    root_closed = true;
                }
            }
            Event::DocType(_) | Event::PI(_) => return Err(invalid()),
            Event::Text(text) if depth == 0 && !text.iter().all(u8::is_ascii_whitespace) => {
                return Err(invalid())
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if first
        || !root_closed
        || depth != 0
        || name == "word/document.xml" && !body
        || name == "[Content_Types].xml" && !main_type
        || name == "_rels/.rels" && !document_relationship
    {
        return Err(invalid());
    }
    Ok(())
}

/// Inspect every ZIP entry without extracting anything. Bounds apply to both
/// compressed and expanded bytes, and reading each entry checks its CRC.
fn validate_package(bytes: &[u8]) -> Result<(), String> {
    let invalid = || "Orion received an invalid Word document.".to_string();
    if bytes.is_empty() || bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(invalid());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid())?;
    if archive.is_empty() || archive.len() > MAX_ENTRIES {
        return Err(invalid());
    }
    let mut total: u64 = 0;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| invalid())?;
        let name = entry.name().to_owned();
        if entry.enclosed_name().is_none()
            || name.contains('\\')
            || !names.insert(name.clone())
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || name.to_ascii_lowercase().contains("vba")
            || name.to_ascii_lowercase().starts_with("word/activex/")
            || name.to_ascii_lowercase().starts_with("word/embeddings/")
            || !(name == "[Content_Types].xml"
                || name.starts_with("word/")
                || name.starts_with("docProps/")
                || name.starts_with("_rels/"))
        {
            return Err(invalid());
        }
        total = total.checked_add(entry.size()).ok_or_else(invalid)?;
        if total > MAX_DOCUMENT_BYTES as u64
            || (name.ends_with(".xml") || name.ends_with(".rels")) && entry.size() > MAX_XML_BYTES
        {
            return Err("This Word document expands beyond Orion's export limit.".into());
        }
        if entry.is_dir() {
            continue;
        }
        // Our documents contain OOXML and embedded raster images only. Never
        // save a macro, ActiveX object, embedded executable, or remote template.
        if ![".xml", ".rels", ".png", ".jpg", ".jpeg", ".gif"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
        {
            return Err(invalid());
        }
        let expected_size = entry.size();
        let xml_entry = name.ends_with(".xml") || name.ends_with(".rels");
        let mut limited = (&mut entry).take(
            if xml_entry {
                MAX_XML_BYTES
            } else {
                MAX_DOCUMENT_BYTES as u64
            } + 1,
        );
        let actual_size = if xml_entry {
            let mut xml = String::new();
            let size = limited.read_to_string(&mut xml).map_err(|_| invalid())? as u64;
            validate_xml(&name, &xml)?;
            size
        } else {
            std::io::copy(&mut limited, &mut std::io::sink()).map_err(|_| invalid())?
        };
        if actual_size != expected_size {
            return Err(invalid());
        }
    }
    if !["[Content_Types].xml", "word/document.xml", "_rels/.rels"]
        .iter()
        .all(|name| names.contains(*name))
    {
        return Err(invalid());
    }
    Ok(())
}

fn persist_document(
    path: &Path,
    bytes: &[u8],
    check: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let directory = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| "Choose an existing folder for the Word document.".to_string())?;
    let mut temporary = NamedTempFile::new_in(directory)
        .map_err(|error| format!("Orion could not prepare the Word document: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Orion could not write the Word document: {error}"))?;
    check()?;
    temporary
        .persist(path)
        .map_err(|error| format!("Orion could not save the Word document: {}", error.error))?;
    crate::sync_directory(directory)
}

#[tauri::command]
pub(crate) async fn export_word_document(
    app: AppHandle,
    request: WordExportRequest,
) -> Result<WordExportResult, String> {
    let workflow = request.workflow.clone();
    let (bytes, file_name) = tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode(&request)?;
        let requested_stem = Path::new(request.file_name.trim())
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Orion export");
        let name = format!("{}.docx", crate::safe_file_stem(requested_stem));
        Ok::<_, String>((bytes, name))
    })
    .await
    .map_err(|error| format!("Orion could not prepare the Word export: {error}"))??;
    check_workflow(&app, workflow.as_ref())?;
    let selected = app
        .dialog()
        .file()
        .set_title("Export Orion Word document")
        .set_file_name(file_name)
        .add_filter("Word document", &["docx"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(WordExportResult {
            path: String::new(),
            cancelled: true,
        });
    };
    let mut path = crate::selected_export_path(selected)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"))
    {
        path.set_extension("docx");
    }
    let destination = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut began_commit = false;
        let outcome = persist_document(&destination, &bytes, || {
            if let Some(workflow) = &workflow {
                app.state::<crate::assistant_bridge::AssistantBridge>()
                    .begin_export_commit(&workflow.job_id, &workflow.session_id)?;
                began_commit = true;
            }
            Ok(())
        });
        if began_commit {
            if let Some(workflow) = &workflow {
                app.state::<crate::assistant_bridge::AssistantBridge>()
                    .finish_export_commit(
                        &workflow.job_id,
                        &workflow.session_id,
                        outcome
                            .as_ref()
                            .map(|_| destination.to_string_lossy().into_owned())
                            .map_err(Clone::clone),
                    )?;
            }
        }
        outcome
    })
    .await
    .map_err(|error| format!("The Word export task could not finish: {error}"))??;
    Ok(WordExportResult {
        path: path.to_string_lossy().into_owned(),
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(extra_name: Option<&str>) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, text) in [
            ("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),
            ("_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"),
            ("word/document.xml", "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p/></w:body></w:document>"),
        ] {
            zip.start_file(name, options).unwrap(); zip.write_all(text.as_bytes()).unwrap();
        }
        if let Some(name) = extra_name {
            zip.start_file(name, options).unwrap();
            zip.write_all(b"extra").unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn accepts_a_real_bounded_word_package_and_rejects_non_documents() {
        assert!(validate_package(&fixture(None)).is_ok());
        for bytes in [&b"not a zip"[..], &b"PK\x03\x04broken"[..], &[][..]] {
            assert!(validate_package(bytes).is_err());
        }
        for name in [
            "../escaped.xml",
            "word/vbaProject.bin",
            "word/active.bin",
            "word\\document.xml",
            "outside/extra.xml",
            "word/activeX/active.xml",
            "word/embeddings/object.xml",
        ] {
            assert!(validate_package(&fixture(Some(name))).is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_external_templates_entities_fields_and_unsafe_relationships() {
        let rel = |kind: &str, target: &str, mode: &str| {
            format!("<Relationships xmlns=\"{REL_NAMESPACE}\"><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}\" Target=\"{target}\" TargetMode=\"{mode}\"/></Relationships>")
        };
        assert!(validate_xml(
            "word/_rels/document.xml.rels",
            &rel("hyperlink", "https://example.com/reference", "External")
        )
        .is_ok());
        for (kind, target, mode) in [
            (
                "attachedTemplate",
                "https://example.com/template.dotx",
                "External",
            ),
            ("image", "https://example.com/tracker.png", "External"),
            ("hyperlink", "file:///private/secret", "External"),
            ("hyperlink", "javascript:alert(1)", "External"),
            ("image", "../../secret.png", "Internal"),
            ("oleObject", "embeddings/object.xml", "Internal"),
        ] {
            assert!(
                validate_xml("word/_rels/document.xml.rels", &rel(kind, target, mode)).is_err(),
                "{kind} {target}"
            );
        }
        assert!(validate_xml(
            "word/settings.xml",
            "<!DOCTYPE settings [<!ENTITY remote SYSTEM 'file:///private/secret'>]><settings/>"
        )
        .is_err());
        assert!(validate_xml("word/extra.xml", "<root/><root/>").is_err());
        assert!(validate_xml(
            "word/extra.xml",
            "<root><w:instrText>INCLUDEPICTURE remote</w:instrText></root>"
        )
        .is_err());
        assert!(validate_xml("word/extra.xml", "<root>").is_err());
    }

    #[test]
    fn accepts_the_actual_renderer_docx_fixture() {
        let bytes = include_bytes!("../tests/fixtures/word-export.docx");
        assert!(validate_package(bytes).is_ok());
    }

    #[test]
    fn bounds_and_checks_the_renderer_request_before_showing_a_dialog() {
        let mut request = WordExportRequest {
            file_name: "notes.docx".into(),
            base64_data: STANDARD.encode(fixture(None)),
            workflow: None,
        };
        assert!(decode(&request).is_ok());
        request.base64_data = "not base64".into();
        assert!(decode(&request).is_err());
        request.base64_data = STANDARD.encode(fixture(None));
        request.file_name = "x".repeat(241);
        assert!(decode(&request).is_err());
        request.file_name = "bad\0.docx".into();
        assert!(decode(&request).is_err());
        assert!(serde_json::from_str::<WordExportRequest>(
            r#"{"fileName":"x.docx","base64Data":"AA==","path":"/tmp/unauthorized"}"#
        )
        .is_err());
    }

    #[test]
    fn writes_complete_document_atomically_without_temporary_residue() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notes.docx");
        std::fs::write(&path, b"old document").unwrap();
        let bytes = fixture(None);
        persist_document(&path, &bytes, || Ok(())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        assert!(
            persist_document(&directory.path().join("missing/note.docx"), &bytes, || Ok(
                ()
            ))
            .is_err()
        );
        assert!(
            persist_document(&path, b"cancelled replacement", || Err("cancelled".into())).is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
