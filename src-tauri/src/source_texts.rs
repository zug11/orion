//! Desktop store for preserved source text.
//!
//! Source text is immutable once imported and can be megabytes per source. It
//! is kept beside the vault in content-addressed files so `vault.json`, which
//! is re-read and rewritten on every autosave, stays proportional to the notes.
//! The shared `source_text_ref` module owns the reference format and reads; this
//! module owns hashing, atomic writes and pruning, mirroring the note-image
//! store: opaque validated names, a private app-data folder, atomic replacement.

use crate::source_text_ref::{
    self, SourceTextRef, MAX_SOURCE_TEXT_BYTES, SOURCE_TEXT_MISSING_PREFIX,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tauri::AppHandle;
use tempfile::NamedTempFile;

/// One IPC request. The renderer batches well below this.
const MAX_REQUEST_TEXTS: usize = 4_096;
const MAX_REQUEST_BYTES: u64 = 96 * 1024 * 1024;
/// Unreferenced text is kept this long. A window may have stored text for a
/// vault it has not saved yet, and a deleted source may be restored by Undo.
const PRUNE_GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const PRUNE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

static LAST_PRUNE: Mutex<Option<Instant>> = Mutex::new(None);

/// Wire form of a reference: the `textRef` value stored on a source record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSourceText {
    sha256: String,
    bytes: u64,
    chars: u64,
}

impl StoredSourceText {
    fn reference(&self) -> Result<SourceTextRef, String> {
        source_text_ref::parse_source_text_ref(&serde_json::json!({
            "sha256": self.sha256, "bytes": self.bytes, "chars": self.chars,
        }))
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    source_text_ref::source_text_directory(&crate::vault_path(app)?)
}

/// Stores one text under its content hash. Writing the same text again is a
/// no-op apart from refreshing its age, so concurrent windows cannot conflict.
fn store_source_text(directory: &Path, text: &str) -> Result<StoredSourceText, String> {
    let bytes = text.len() as u64;
    if bytes == 0 {
        return Err("Empty source text is stored inline.".to_string());
    }
    if bytes > MAX_SOURCE_TEXT_BYTES {
        return Err("That source is too large for Orion to preserve.".to_string());
    }
    let stored = StoredSourceText {
        sha256: digest(text.as_bytes()),
        bytes,
        chars: text.chars().count() as u64,
    };
    let path = source_text_ref::source_text_path(directory, &stored.sha256)?;
    // A matching file is reused only after its content is verified, so a
    // damaged file is repaired rather than trusted for its name.
    if fs::read(&path).is_ok_and(|existing| digest(&existing) == stored.sha256) {
        // Restart the prune grace period for text that is in use again.
        let _ = File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(SystemTime::now()));
        return Ok(stored);
    }
    fs::create_dir_all(directory)
        .map_err(|error| format!("Orion could not create its source text folder: {error}"))?;
    let mut temporary = NamedTempFile::new_in(directory)
        .map_err(|error| format!("Orion could not prepare that source text: {error}"))?;
    temporary
        .as_file_mut()
        .write_all(text.as_bytes())
        .and_then(|_| temporary.as_file_mut().flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Orion could not save that source text: {error}"))?;
    temporary
        .persist(&path)
        .map_err(|error| format!("Orion could not save that source text: {}", error.error))?;
    Ok(stored)
}

fn write_source_texts(directory: &Path, texts: &[String]) -> Result<Vec<StoredSourceText>, String> {
    if texts.len() > MAX_REQUEST_TEXTS
        || texts.iter().map(|text| text.len() as u64).sum::<u64>() > MAX_REQUEST_BYTES
    {
        return Err("Orion received too much source text in one request.".to_string());
    }
    let stored = texts
        .iter()
        .map(|text| store_source_text(directory, text))
        .collect::<Result<Vec<_>, _>>()?;
    if !stored.is_empty() {
        crate::sync_directory(directory)?;
    }
    Ok(stored)
}

/// Reads one text and verifies both its recorded length and its digest.
fn load_source_text(directory: &Path, stored: &StoredSourceText) -> Result<String, String> {
    let reference = stored.reference()?;
    let text = source_text_ref::read_source_text(directory, &reference)?;
    if digest(text.as_bytes()) != reference.sha256 || text.chars().count() as u64 != reference.chars
    {
        return Err(format!(
            "{SOURCE_TEXT_MISSING_PREFIX}: preserved source text {}.txt is missing or damaged.",
            reference.sha256
        ));
    }
    Ok(text)
}

fn read_source_texts(directory: &Path, stored: &[StoredSourceText]) -> Result<Vec<String>, String> {
    if stored.len() > MAX_REQUEST_TEXTS
        || stored.iter().map(|item| item.bytes).sum::<u64>() > MAX_REQUEST_BYTES
    {
        return Err("Orion was asked for too much source text in one request.".to_string());
    }
    stored
        .iter()
        .map(|item| load_source_text(directory, item))
        .collect()
}

/// Removes preserved text that no retained vault refers to and that has been
/// unreferenced for longer than the grace period. Anything unrecognised is left
/// alone. Returns the number of files removed.
fn prune_source_texts(
    directory: &Path,
    live: &HashSet<String>,
    grace: Duration,
    now: SystemTime,
) -> u64 {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // Only this store's own files: `<sha256>.txt` and abandoned temporaries.
        let hash = name.strip_suffix(".txt");
        let orphan = match hash {
            Some(hash) if source_text_ref::valid_source_text_hash(hash) => !live.contains(hash),
            Some(_) => false,
            None => name.starts_with(".tmp"),
        };
        if !orphan {
            continue;
        }
        let old_enough = entry
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= grace);
        if old_enough && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Every content hash a vault value refers to. An unreadable or inconsistent
/// value yields an error so the caller never prunes against a partial set.
fn live_hashes(vault: &Value) -> Result<HashSet<String>, String> {
    Ok(source_text_ref::vault_source_text_refs(vault)?
        .into_iter()
        .map(|(_, reference)| reference.sha256)
        .collect())
}

/// Called with the vault write lock held, after a successful save. `retained`
/// are other vault files (backups) whose text must also survive. Throttled, and
/// skipped entirely if any retained vault cannot be read.
pub(crate) fn prune_after_save(vault_path: &Path, saved: &Value, retained: &[PathBuf]) {
    {
        let mut last = LAST_PRUNE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| at.elapsed() < PRUNE_INTERVAL) {
            return;
        }
        *last = Some(Instant::now());
    }
    let Ok(directory) = source_text_ref::source_text_directory(vault_path) else {
        return;
    };
    let Ok(mut live) = live_hashes(saved) else {
        return;
    };
    for path in retained {
        match crate::read_vault_file(path).map(|value| value.map(|value| live_hashes(&value))) {
            Ok(Some(Ok(hashes))) => live.extend(hashes),
            Ok(None) => {}
            _ => return,
        }
    }
    prune_source_texts(&directory, &live, PRUNE_GRACE, SystemTime::now());
}

#[tauri::command]
pub(crate) async fn save_source_texts(
    app: AppHandle,
    texts: Vec<String>,
) -> Result<Vec<StoredSourceText>, String> {
    let directory = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_source_texts(&directory, &texts))
        .await
        .map_err(|error| format!("The source text save task could not finish: {error}"))?
}

#[tauri::command]
pub(crate) async fn load_source_texts(
    app: AppHandle,
    references: Vec<StoredSourceText>,
) -> Result<Vec<String>, String> {
    let directory = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_source_texts(&directory, &references))
        .await
        .map_err(|error| format!("The source text read task could not finish: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TEXT: &str = "Café ☕ — the owl of Minerva spreads its wings only at dusk.";

    #[test]
    fn stores_text_once_under_its_content_hash_and_reads_it_back_verified() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("attachments").join("sources");
        let stored = write_source_texts(&folder, &[TEXT.to_string(), TEXT.to_string()]).unwrap();
        assert_eq!(stored[0], stored[1]);
        assert_eq!(stored[0].bytes, TEXT.len() as u64);
        assert_eq!(stored[0].chars, TEXT.chars().count() as u64);
        // SHA-256 of the UTF-8 bytes, lower-case hex: other tools can verify it.
        assert_eq!(stored[0].sha256, digest(TEXT.as_bytes()));
        assert_eq!(stored[0].sha256.len(), 64);
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        assert_eq!(
            fs::read_to_string(folder.join(format!("{}.txt", stored[0].sha256))).unwrap(),
            TEXT
        );
        assert_eq!(read_source_texts(&folder, &stored).unwrap(), [TEXT, TEXT]);
        assert_eq!(
            serde_json::to_value(&stored[0]).unwrap(),
            json!({"sha256": stored[0].sha256, "bytes": TEXT.len(), "chars": TEXT.chars().count()})
        );
    }

    #[test]
    fn rejects_empty_oversized_and_unbounded_requests() {
        let directory = tempfile::tempdir().unwrap();
        assert!(store_source_text(directory.path(), "").is_err());
        assert!(write_source_texts(
            directory.path(),
            &vec!["x".to_string(); MAX_REQUEST_TEXTS + 1]
        )
        .is_err());
        let many = vec![
            StoredSourceText {
                sha256: "a".repeat(64),
                bytes: MAX_SOURCE_TEXT_BYTES,
                chars: MAX_SOURCE_TEXT_BYTES
            };
            2
        ];
        assert!(read_source_texts(directory.path(), &many).is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn damaged_or_substituted_text_fails_closed_and_is_repaired_by_a_fresh_store() {
        let directory = tempfile::tempdir().unwrap();
        let stored = store_source_text(directory.path(), TEXT).unwrap();
        let path = directory.path().join(format!("{}.txt", stored.sha256));

        // Same length, different content: only the digest can catch it.
        let mut tampered = TEXT.as_bytes().to_vec();
        tampered[0] ^= 0x01;
        fs::write(&path, &tampered).unwrap();
        let error = load_source_text(directory.path(), &stored).unwrap_err();
        assert!(error.starts_with(SOURCE_TEXT_MISSING_PREFIX), "{error}");

        fs::remove_file(&path).unwrap();
        assert!(load_source_text(directory.path(), &stored)
            .unwrap_err()
            .starts_with(SOURCE_TEXT_MISSING_PREFIX));

        // A reference can never name a file outside the folder.
        let escape = StoredSourceText {
            sha256: "../vault".into(),
            bytes: 1,
            chars: 1,
        };
        assert!(load_source_text(directory.path(), &escape).is_err());

        fs::write(&path, &tampered).unwrap();
        assert_eq!(store_source_text(directory.path(), TEXT).unwrap(), stored);
        assert_eq!(load_source_text(directory.path(), &stored).unwrap(), TEXT);
    }

    #[test]
    fn a_vault_cannot_be_written_while_it_points_at_unstored_text() {
        let directory = tempfile::tempdir().unwrap();
        let vault_path = directory.path().join("vault.json");
        let folder = source_text_ref::source_text_directory(&vault_path).unwrap();
        let stored = StoredSourceText {
            sha256: digest(TEXT.as_bytes()),
            bytes: TEXT.len() as u64,
            chars: TEXT.chars().count() as u64,
        };
        let vault = json!({"schemaVersion": 3, "updatedAt": "v1", "activeSpaceId": "a", "spaces": [{
            "schemaVersion": 1, "workspace": {"id": "a"}, "notes": [],
            "sources": [{"id": "s", "title": "Lecture", "textRef": stored}],
        }]});
        let error = crate::write_vault_file_if_current(&vault_path, &vault, None).unwrap_err();
        assert!(error.starts_with(SOURCE_TEXT_MISSING_PREFIX), "{error}");
        assert!(error.contains("Lecture"));
        assert!(!vault_path.exists());

        store_source_text(&folder, TEXT).unwrap();
        crate::write_vault_file_if_current(&vault_path, &vault, None).unwrap();
        assert_eq!(crate::read_vault_file(&vault_path).unwrap().unwrap(), vault);
    }

    #[test]
    fn prune_removes_only_old_unreferenced_text_and_abandoned_temporaries() {
        let directory = tempfile::tempdir().unwrap();
        let kept = store_source_text(directory.path(), "referenced").unwrap();
        let orphan = store_source_text(directory.path(), "orphaned long ago").unwrap();
        let recent = store_source_text(directory.path(), "stored but not saved yet").unwrap();
        fs::write(directory.path().join(".tmpAbandoned"), "partial").unwrap();
        fs::write(directory.path().join("notes.txt"), "not ours").unwrap();
        fs::write(directory.path().join("README"), "not ours").unwrap();

        let live: HashSet<String> = [kept.sha256.clone()].into();
        let now = SystemTime::now();
        // Inside the grace period nothing is removed, referenced or not.
        assert_eq!(
            prune_source_texts(directory.path(), &live, PRUNE_GRACE, now),
            0
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 6);

        // Age everything except the recently stored text past the grace period.
        let later = now + PRUNE_GRACE + Duration::from_secs(60);
        File::options()
            .write(true)
            .open(directory.path().join(format!("{}.txt", recent.sha256)))
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_eq!(
            prune_source_texts(directory.path(), &live, PRUNE_GRACE, later),
            2
        );
        let mut names: Vec<String> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut expected = vec![
            "README".to_string(),
            "notes.txt".to_string(),
            format!("{}.txt", kept.sha256),
            format!("{}.txt", recent.sha256),
        ];
        expected.sort();
        assert_eq!(names, expected);
        assert!(!directory
            .path()
            .join(format!("{}.txt", orphan.sha256))
            .exists());
    }

    #[test]
    fn reusing_stored_text_restarts_its_grace_period() {
        let directory = tempfile::tempdir().unwrap();
        let stored = store_source_text(directory.path(), TEXT).unwrap();
        let path = directory.path().join(format!("{}.txt", stored.sha256));
        let long_ago = SystemTime::now() - PRUNE_GRACE - Duration::from_secs(3600);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        // The same text is imported again: it must not be pruned before its save.
        store_source_text(directory.path(), TEXT).unwrap();
        assert_eq!(
            prune_source_texts(
                directory.path(),
                &HashSet::new(),
                PRUNE_GRACE,
                SystemTime::now()
            ),
            0
        );
        assert!(path.exists());
    }

    #[test]
    fn live_hashes_cover_every_space_and_refuse_inconsistent_vaults() {
        let reference = |hash: &str| json!({"sha256": hash, "bytes": 4, "chars": 4});
        let vault = json!({"schemaVersion": 3, "spaces": [
            {"sources": [{"title": "A", "textRef": reference(&"a".repeat(64))}, {"title": "Inline", "text": "x"}]},
            {"sources": [{"title": "B", "textRef": reference(&"b".repeat(64))}]},
        ]});
        assert_eq!(
            live_hashes(&vault).unwrap(),
            ["a".repeat(64), "b".repeat(64)].into()
        );
        let inconsistent = json!({"schemaVersion": 2, "spaces": [{"sources": [{"textRef": reference(&"a".repeat(64))}]}]});
        assert!(live_hashes(&inconsistent).is_err());
    }
}
