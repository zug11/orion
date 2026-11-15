//! References to preserved source text stored beside the vault.
//!
//! Imported source text is immutable and can be megabytes per source, so it
//! lives in content-addressed files (`attachments/sources/<sha256>.txt`) rather
//! than inside `vault.json`. A source record then carries
//! `textRef: { sha256, bytes, chars }` instead of `text`.
//!
//! This module is shared by the desktop host and the MCP server. It validates
//! references and reads files. Hashing and writing belong to the desktop host.

use serde_json::Value;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

/// Vaults whose sources all carry inline text keep schema 2.
pub const INLINE_VAULT_SCHEMA_VERSION: u64 = 2;
/// A vault with at least one `textRef` is written as schema 3, so a binary that
/// only understands inline text rejects it instead of reading sources as empty.
pub const EXTERNAL_TEXT_VAULT_SCHEMA_VERSION: u64 = 3;
/// One preserved source text. Matches the desktop host's write bound.
pub const MAX_SOURCE_TEXT_BYTES: u64 = 64 * 1024 * 1024;
/// Stable prefix the renderer recognises to re-send text and retry a save.
pub const SOURCE_TEXT_MISSING_PREFIX: &str = "ORION_SOURCE_TEXT_MISSING";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceTextRef {
    pub sha256: String,
    pub bytes: u64,
    pub chars: u64,
}

pub fn supported_vault_schema(version: u64) -> bool {
    version == INLINE_VAULT_SCHEMA_VERSION || version == EXTERNAL_TEXT_VAULT_SCHEMA_VERSION
}

/// Side files sit next to the vault, so an overridden vault path keeps working.
pub fn source_text_directory(vault_path: &Path) -> Result<PathBuf, String> {
    vault_path
        .parent()
        .map(|directory| directory.join("attachments").join("sources"))
        .ok_or_else(|| "Orion could not resolve its source text folder.".to_string())
}

pub fn valid_source_text_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Strict shape: exactly `sha256`, `bytes` and `chars`, mutually consistent.
pub fn parse_source_text_ref(value: &Value) -> Result<SourceTextRef, String> {
    let invalid = || "A source has an invalid text reference.".to_string();
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != 3 {
        return Err(invalid());
    }
    let sha256 = object
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|hash| valid_source_text_hash(hash))
        .ok_or_else(invalid)?;
    let bytes = object
        .get("bytes")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let chars = object
        .get("chars")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    // Empty text stays inline. A scalar is one to four UTF-8 bytes.
    if bytes == 0
        || bytes > MAX_SOURCE_TEXT_BYTES
        || chars == 0
        || chars > bytes
        || bytes > chars * 4
    {
        return Err(invalid());
    }
    Ok(SourceTextRef {
        sha256: sha256.to_string(),
        bytes,
        chars,
    })
}

/// The reference is validated again here, so a caller can never build a path
/// from unchecked input.
pub fn source_text_path(directory: &Path, sha256: &str) -> Result<PathBuf, String> {
    if !valid_source_text_hash(sha256) {
        return Err("A source has an invalid text reference.".to_string());
    }
    Ok(directory.join(format!("{sha256}.txt")))
}

/// Reads one preserved text and checks its recorded length. The desktop host
/// additionally verifies the SHA-256 digest.
pub fn read_source_text(directory: &Path, reference: &SourceTextRef) -> Result<String, String> {
    let path = source_text_path(directory, &reference.sha256)?;
    let missing = || {
        format!(
            "{SOURCE_TEXT_MISSING_PREFIX}: preserved source text {}.txt is missing or damaged.",
            reference.sha256
        )
    };
    let mut file = File::open(&path).map_err(|_| missing())?;
    let length = file.metadata().map_err(|_| missing())?.len();
    if length != reference.bytes {
        return Err(missing());
    }
    let mut text = String::with_capacity(length as usize);
    file.read_to_string(&mut text).map_err(|_| missing())?;
    if text.len() as u64 != reference.bytes {
        return Err(missing());
    }
    Ok(text)
}

/// Every text reference in a raw vault value, with the owning source's title.
/// Also enforces the format invariants: a reference never coexists with inline
/// text, and never appears in a schema 2 vault.
pub fn vault_source_text_refs(vault: &Value) -> Result<Vec<(String, SourceTextRef)>, String> {
    let schema = vault.get("schemaVersion").and_then(Value::as_u64);
    let mut references = Vec::new();
    let spaces = match vault.get("spaces").and_then(Value::as_array) {
        Some(spaces) => spaces,
        None => return Ok(references),
    };
    for space in spaces {
        let sources = match space.get("sources").and_then(Value::as_array) {
            Some(sources) => sources,
            None => continue,
        };
        for source in sources {
            let Some(reference) = source.get("textRef") else {
                continue;
            };
            if source.get("text").is_some() {
                return Err("A source has both inline text and a text reference.".to_string());
            }
            if schema != Some(EXTERNAL_TEXT_VAULT_SCHEMA_VERSION) {
                return Err(
                    "A source text reference requires the external-text vault schema.".to_string(),
                );
            }
            let title = source
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled source")
                .chars()
                .take(120)
                .collect();
            references.push((title, parse_source_text_ref(reference)?));
        }
    }
    Ok(references)
}

/// A vault must never be written while it points at text that is not on disk.
/// Checks existence and recorded length only, so it stays cheap on every save.
pub fn verify_vault_source_texts(vault: &Value, directory: &Path) -> Result<(), String> {
    for (title, reference) in vault_source_text_refs(vault)? {
        let path = source_text_path(directory, &reference.sha256)?;
        let present = fs::metadata(&path)
            .map(|metadata| metadata.is_file() && metadata.len() == reference.bytes)
            .unwrap_or(false);
        if !present {
            return Err(format!(
                "{SOURCE_TEXT_MISSING_PREFIX}: the preserved text for “{title}” is not stored yet."
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HASH: &str = "a3f5c1d2e4b6978801234567890abcdefa3f5c1d2e4b6978801234567890abcd";

    fn vault(schema: u64, source: Value) -> Value {
        json!({"schemaVersion": schema, "spaces": [{"sources": [source]}]})
    }

    #[test]
    fn accepts_only_strict_consistent_references() {
        let valid = json!({"sha256": HASH, "bytes": 12, "chars": 10});
        assert_eq!(
            parse_source_text_ref(&valid).unwrap(),
            SourceTextRef {
                sha256: HASH.into(),
                bytes: 12,
                chars: 10
            }
        );
        for invalid in [
            json!({"sha256": HASH, "bytes": 12}),
            json!({"sha256": HASH, "bytes": 12, "chars": 10, "path": "/etc/passwd"}),
            json!({"sha256": HASH.to_uppercase(), "bytes": 12, "chars": 10}),
            json!({"sha256": "../../etc/passwd", "bytes": 12, "chars": 10}),
            json!({"sha256": HASH, "bytes": 0, "chars": 0}),
            json!({"sha256": HASH, "bytes": 3, "chars": 4}),
            json!({"sha256": HASH, "bytes": 41, "chars": 10}),
            json!({"sha256": HASH, "bytes": MAX_SOURCE_TEXT_BYTES + 1, "chars": MAX_SOURCE_TEXT_BYTES}),
            json!("text"),
        ] {
            assert!(parse_source_text_ref(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn paths_stay_inside_the_source_text_folder() {
        let directory = source_text_directory(Path::new("/data/vault.json")).unwrap();
        assert_eq!(directory, Path::new("/data/attachments/sources"));
        assert_eq!(
            source_text_path(&directory, HASH).unwrap(),
            directory.join(format!("{HASH}.txt"))
        );
        assert!(source_text_path(&directory, "../vault").is_err());
        assert!(source_text_path(&directory, "").is_err());
    }

    #[test]
    fn enforces_reference_and_schema_invariants() {
        let reference = json!({"sha256": HASH, "bytes": 5, "chars": 5});
        let external = vault(3, json!({"title": "Book", "textRef": reference}));
        assert_eq!(vault_source_text_refs(&external).unwrap().len(), 1);
        assert_eq!(vault_source_text_refs(&external).unwrap()[0].0, "Book");
        let inline = vault(2, json!({"title": "Book", "text": "hello"}));
        assert!(vault_source_text_refs(&inline).unwrap().is_empty());
        assert!(vault_source_text_refs(&vault(2, json!({"textRef": reference}))).is_err());
        assert!(
            vault_source_text_refs(&vault(3, json!({"text": "", "textRef": reference}))).is_err()
        );
        assert!(vault_source_text_refs(&vault(3, json!({"textRef": {"sha256": "x"}}))).is_err());
        assert!(supported_vault_schema(2) && supported_vault_schema(3));
        assert!(!supported_vault_schema(1) && !supported_vault_schema(4));
    }

    #[test]
    fn reads_and_verifies_against_the_recorded_length() {
        let directory = tempfile::tempdir().unwrap();
        let reference = SourceTextRef {
            sha256: HASH.into(),
            bytes: 7,
            chars: 6,
        };
        let stored = vault(
            3,
            json!({"title": "Café", "textRef": {"sha256": HASH, "bytes": 7, "chars": 6}}),
        );
        let missing = verify_vault_source_texts(&stored, directory.path()).unwrap_err();
        assert!(missing.starts_with(SOURCE_TEXT_MISSING_PREFIX), "{missing}");
        assert!(read_source_text(directory.path(), &reference)
            .unwrap_err()
            .starts_with(SOURCE_TEXT_MISSING_PREFIX));

        fs::write(directory.path().join(format!("{HASH}.txt")), "café ☕").unwrap();
        // Ten bytes on disk, seven recorded: a truncated or replaced file fails closed.
        assert!(verify_vault_source_texts(&stored, directory.path()).is_err());
        assert!(read_source_text(directory.path(), &reference).is_err());

        fs::write(directory.path().join(format!("{HASH}.txt")), "café ok").unwrap();
        assert_eq!(
            read_source_text(
                directory.path(),
                &SourceTextRef {
                    bytes: 8,
                    chars: 7,
                    ..reference.clone()
                }
            )
            .unwrap(),
            "café ok"
        );
        let exact = vault(
            3,
            json!({"title": "Café", "textRef": {"sha256": HASH, "bytes": 8, "chars": 7}}),
        );
        verify_vault_source_texts(&exact, directory.path()).unwrap();
        fs::write(
            directory.path().join(format!("{HASH}.txt")),
            [0xff, 0xfe, 0xfd, 0, 0, 0, 0, 0],
        )
        .unwrap();
        assert!(read_source_text(
            directory.path(),
            &SourceTextRef {
                bytes: 8,
                chars: 7,
                ..reference
            }
        )
        .is_err());
    }
}
