//! Rotating backups of `vault.json`.
//!
//! Atomic replacement protects a save from being torn. It does not protect the
//! library from a save that is valid but wrong, or from a file damaged later.
//! Before the vault is replaced, the version being replaced is kept under
//! `backups/` with a hard link (no copy: the replacement gets a new inode, so
//! the link keeps the old content). Retention keeps a few recent versions plus
//! one per recent day and week.
//!
//! Since source text lives beside the vault, a backup is small, and a backup of
//! a library from before that change still carries its text inline.

use crate::source_text_ref;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, State};
use time::{Date, Month, OffsetDateTime};

const BACKUP_DIRECTORY: &str = "backups";
/// At most one backup per this interval, so typing does not flood the folder.
const MINIMUM_INTERVAL_SECONDS: i64 = 10 * 60;
const KEEP_RECENT: usize = 3;
const KEEP_DAILY: usize = 7;
const KEEP_WEEKLY: usize = 4;
/// Files set aside by a restore are kept, but not without bound.
const KEEP_REPLACED: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultBackup {
    name: String,
    /// RFC 3339 UTC time at which this version stopped being the live vault.
    saved_at: String,
    bytes: u64,
}

fn backup_directory(vault_path: &Path) -> Result<PathBuf, String> {
    vault_path
        .parent()
        .map(|directory| directory.join(BACKUP_DIRECTORY))
        .ok_or_else(|| "Orion could not resolve its backup folder.".to_string())
}

fn stamp(now: OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// `vault-YYYYMMDDTHHMMSSZ.json` → its time. Anything else is not a backup.
fn backup_time(name: &str) -> Option<OffsetDateTime> {
    let stamp = name.strip_prefix("vault-")?.strip_suffix(".json")?;
    let bytes = stamp.as_bytes();
    if bytes.len() != 16
        || bytes[8] != b'T'
        || bytes[15] != b'Z'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 15) || byte.is_ascii_digit())
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| stamp[range].parse::<i32>().ok();
    let date = Date::from_calendar_date(
        number(0..4)?,
        Month::try_from(number(4..6)? as u8).ok()?,
        number(6..8)? as u8,
    )
    .ok()?;
    date.with_hms(
        number(9..11)? as u8,
        number(11..13)? as u8,
        number(13..15)? as u8,
    )
    .ok()
    .map(|time| time.assume_utc())
}

/// Backup names, newest first. Fixed-width UTC stamps sort chronologically.
fn backup_names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| backup_time(name).is_some())
        .collect();
    names.sort_unstable_by(|left, right| right.cmp(left));
    names
}

/// The names retention keeps: the newest few, then the newest of each recent
/// day and ISO week.
fn retained(names: &[String]) -> HashSet<&str> {
    let mut keep: HashSet<&str> = names.iter().take(KEEP_RECENT).map(String::as_str).collect();
    let mut days = HashSet::new();
    let mut weeks = HashSet::new();
    for name in names {
        let Some(time) = backup_time(name) else {
            continue;
        };
        let day = time.date();
        if days.len() < KEEP_DAILY && days.insert(day) {
            keep.insert(name);
        }
        let (year, week, _) = day.to_iso_week_date();
        if weeks.len() < KEEP_WEEKLY && weeks.insert((year, week)) {
            keep.insert(name);
        }
    }
    keep
}

fn link_or_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        return Ok(());
    }
    fs::hard_link(from, to).or_else(|_| fs::copy(from, to).map(|_| ()))
}

/// Keeps the vault that is about to be replaced. Best effort: a backup that
/// cannot be made must never stop the user's save.
pub(crate) fn backup_before_replace(vault_path: &Path, now: OffsetDateTime) {
    let _ = try_backup(vault_path, now);
}

fn try_backup(vault_path: &Path, now: OffsetDateTime) -> Result<(), String> {
    if !vault_path.is_file() {
        return Ok(());
    }
    let directory = backup_directory(vault_path)?;
    let names = backup_names(&directory);
    let recent = names
        .first()
        .and_then(|name| backup_time(name))
        .is_some_and(|latest| (now - latest).whole_seconds() < MINIMUM_INTERVAL_SECONDS);
    if recent {
        return Ok(());
    }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    link_or_copy(
        vault_path,
        &directory.join(format!("vault-{}.json", stamp(now))),
    )
    .map_err(|error| error.to_string())?;
    let names = backup_names(&directory);
    let keep = retained(&names);
    for name in names.iter().filter(|name| !keep.contains(name.as_str())) {
        let _ = fs::remove_file(directory.join(name));
    }
    Ok(())
}

/// Every retained backup, for callers that must keep what backups refer to.
pub(crate) fn backup_paths(vault_path: &Path) -> Vec<PathBuf> {
    backup_directory(vault_path)
        .map(|directory| {
            backup_names(&directory)
                .into_iter()
                .map(|name| directory.join(name))
                .collect()
        })
        .unwrap_or_default()
}

fn list_backups(vault_path: &Path) -> Result<Vec<VaultBackup>, String> {
    let directory = backup_directory(vault_path)?;
    Ok(backup_names(&directory)
        .into_iter()
        .filter_map(|name| {
            let time = backup_time(&name)?;
            let bytes = fs::metadata(directory.join(&name)).ok()?.len();
            Some(VaultBackup {
                saved_at: format!(
                    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                    time.year(),
                    u8::from(time.month()),
                    time.day(),
                    time.hour(),
                    time.minute(),
                    time.second()
                ),
                name,
                bytes,
            })
        })
        .collect())
}

/// Replaces the vault with a backup. The caller holds the vault write lock.
/// The backup must be a readable vault whose source text is still on disk, and
/// whatever it replaces is set aside first, readable or not.
fn restore_backup(vault_path: &Path, name: &str, now: OffsetDateTime) -> Result<(), String> {
    if backup_time(name).is_none() {
        return Err("That is not an Orion backup.".to_string());
    }
    let directory = backup_directory(vault_path)?;
    let value: Value = crate::read_vault_file(&directory.join(name))
        .map_err(|_| "That backup could not be read.".to_string())?
        .ok_or_else(|| "That backup no longer exists.".to_string())?;
    let supported = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(source_text_ref::supported_vault_schema);
    let has_spaces = value
        .get("spaces")
        .and_then(Value::as_array)
        .is_some_and(|spaces| !spaces.is_empty());
    if !supported || !has_spaces || value.get("updatedAt").and_then(Value::as_str).is_none() {
        return Err("That backup is not a readable Orion library.".to_string());
    }
    source_text_ref::verify_vault_source_texts(
        &value,
        &source_text_ref::source_text_directory(vault_path)?,
    )
    .map_err(|_| "That backup refers to source text that is no longer stored.".to_string())?;

    if vault_path.is_file() {
        link_or_copy(
            vault_path,
            &directory.join(format!("replaced-{}.json", stamp(now))),
        )
        .map_err(|error| format!("Orion could not set the current library aside: {error}"))?;
        let mut replaced: Vec<String> = fs::read_dir(&directory)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("replaced-") && name.ends_with(".json"))
            .collect();
        replaced.sort_unstable_by(|left, right| right.cmp(left));
        for old in replaced.iter().skip(KEEP_REPLACED) {
            let _ = fs::remove_file(directory.join(old));
        }
    }
    crate::write_vault_file(vault_path, &value)
}

#[tauri::command]
pub(crate) async fn list_vault_backups(app: AppHandle) -> Result<Vec<VaultBackup>, String> {
    let path = crate::vault_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_backups(&path))
        .await
        .map_err(|error| format!("The backup list task could not finish: {error}"))?
}

#[tauri::command]
pub(crate) async fn restore_vault_backup(
    app: AppHandle,
    write_lock: State<'_, crate::VaultWriteLock>,
    name: String,
) -> Result<(), String> {
    use fs2::FileExt;
    let path = crate::vault_path(&app)?;
    let write_lock = std::sync::Arc::clone(&write_lock.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = write_lock
            .lock()
            .map_err(|_| "Orion's vault save queue was interrupted.".to_string())?;
        let lock = crate::vault_lock_file(&path)?;
        lock.lock_exclusive()
            .map_err(|error| format!("Orion could not lock the vault for restoring: {error}"))?;
        restore_backup(&path, &name, OffsetDateTime::now_utc())
    })
    .await
    .map_err(|error| format!("The restore task could not finish: {error}"))??;
    let _ = app.emit("orion-vault-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `time`'s macros feature is not enabled in this crate.
    fn at(year: i32, month: u8, day: u8, hour: u8, minute: u8) -> OffsetDateTime {
        Date::from_calendar_date(year, Month::try_from(month).unwrap(), day)
            .unwrap()
            .with_hms(hour, minute, 0)
            .unwrap()
            .assume_utc()
    }

    fn vault(revision: &str) -> Value {
        json!({"schemaVersion": 2, "activeSpaceId": "a", "updatedAt": revision, "spaces": [
            {"schemaVersion": 1, "workspace": {"id": "a"}, "notes": [{"id": "n", "body": revision}], "sources": []}
        ]})
    }

    fn save(path: &Path, revision: &str, now: OffsetDateTime) {
        backup_before_replace(path, now);
        // The same atomic replacement the real save performs.
        let temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap()).unwrap();
        fs::write(
            temporary.path(),
            serde_json::to_vec(&vault(revision)).unwrap(),
        )
        .unwrap();
        temporary.persist(path).unwrap();
    }

    fn revision_of(path: &Path) -> String {
        crate::read_vault_file(path).unwrap().unwrap()["updatedAt"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn keeps_the_replaced_version_and_throttles_within_the_interval() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.json");
        let start = at(2026, 11, 15, 9, 0);

        save(&path, "v1", start);
        // Nothing existed before the first save, so there is nothing to keep.
        assert!(backup_paths(&path).is_empty());

        save(&path, "v2", start + time::Duration::minutes(1));
        let backups = backup_paths(&path);
        assert_eq!(backups.len(), 1);
        // The backup holds the version that was replaced, not the new one.
        assert_eq!(revision_of(&backups[0]), "v1");
        assert_eq!(revision_of(&path), "v2");

        for minute in 2..9 {
            save(
                &path,
                &format!("typing-{minute}"),
                start + time::Duration::minutes(minute),
            );
        }
        assert_eq!(backup_paths(&path).len(), 1);

        save(&path, "v3", start + time::Duration::minutes(12));
        let backups = backup_paths(&path);
        assert_eq!(backups.len(), 2);
        assert_eq!(revision_of(&backups[0]), "typing-8");
    }

    #[test]
    fn retention_keeps_recent_daily_and_weekly_versions_only() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.json");
        fs::write(&path, serde_json::to_vec(&vault("live")).unwrap()).unwrap();
        let folder = backup_directory(&path).unwrap();
        fs::create_dir_all(&folder).unwrap();
        // Four backups a day for sixty days.
        let first = at(2026, 9, 1, 0, 0);
        for day in 0..60 {
            for hour in [1, 7, 13, 19] {
                let at = first + time::Duration::days(day) + time::Duration::hours(hour);
                fs::write(folder.join(format!("vault-{}.json", stamp(at))), "{}").unwrap();
            }
        }
        fs::write(folder.join("notes.txt"), "not a backup").unwrap();
        fs::write(folder.join("replaced-20260101T000000Z.json"), "{}").unwrap();

        let now = first + time::Duration::days(60);
        try_backup(&path, now).unwrap();
        let names = backup_names(&folder);
        // Newest three, one per day for seven days, one per week for four weeks,
        // with overlaps counted once.
        assert!(
            names.len() <= KEEP_RECENT + KEEP_DAILY + KEEP_WEEKLY,
            "{names:?}"
        );
        assert!(names.len() >= KEEP_DAILY, "{names:?}");
        assert_eq!(names[0], format!("vault-{}.json", stamp(now)));
        let days: HashSet<_> = names
            .iter()
            .map(|name| backup_time(name).unwrap().date())
            .collect();
        assert!(days.len() >= KEEP_DAILY);
        let oldest = backup_time(names.last().unwrap()).unwrap();
        assert!(
            (now - oldest).whole_days() <= 7 * KEEP_WEEKLY as i64,
            "{oldest}"
        );
        // Files that are not backups are never touched.
        assert!(folder.join("notes.txt").exists());
        assert!(folder.join("replaced-20260101T000000Z.json").exists());
    }

    #[test]
    fn only_strictly_named_files_are_backups() {
        assert!(backup_time("vault-20261115T090000Z.json").is_some());
        for name in [
            "vault-20261115T090000Z.json.tmp",
            "vault-2026-11-15.json",
            "vault-20261315T090000Z.json",
            "vault-20261115T250000Z.json",
            "vault-20261115t090000z.json",
            "../vault-20261115T090000Z.json",
            "vault.json",
            "replaced-20261115T090000Z.json",
        ] {
            assert!(backup_time(name).is_none(), "{name}");
        }
    }

    #[test]
    fn restore_replaces_a_damaged_vault_and_sets_it_aside() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.json");
        let start = at(2026, 11, 15, 9, 0);
        save(&path, "good", start);
        save(&path, "newer", start + time::Duration::minutes(20));
        fs::write(&path, b"{ damaged").unwrap();
        assert!(crate::read_vault_file(&path).is_err());

        let backups = list_backups(&path).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].saved_at, "2026-11-15T09:20:00Z");
        restore_backup(&path, &backups[0].name, start + time::Duration::hours(1)).unwrap();
        assert_eq!(revision_of(&path), "good");
        // The damaged file is kept for inspection rather than destroyed.
        let aside = backup_directory(&path)
            .unwrap()
            .join("replaced-20261115T100000Z.json");
        assert_eq!(fs::read(aside).unwrap(), b"{ damaged");
    }

    #[test]
    fn restore_refuses_anything_that_is_not_a_complete_readable_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.json");
        fs::write(&path, serde_json::to_vec(&vault("live")).unwrap()).unwrap();
        let folder = backup_directory(&path).unwrap();
        fs::create_dir_all(&folder).unwrap();
        let now = at(2026, 11, 15, 12, 0);
        let write = |name: &str, value: &Value| {
            fs::write(folder.join(name), serde_json::to_vec(value).unwrap()).unwrap()
        };

        write(
            "vault-20261101T000000Z.json",
            &json!({"schemaVersion": 9, "updatedAt": "x", "spaces": [{}]}),
        );
        write(
            "vault-20261102T000000Z.json",
            &json!({"schemaVersion": 2, "updatedAt": "x", "spaces": []}),
        );
        fs::write(folder.join("vault-20261103T000000Z.json"), b"not json").unwrap();
        // References text that is no longer stored beside the vault.
        write(
            "vault-20261104T000000Z.json",
            &json!({"schemaVersion": 3, "updatedAt": "x", "activeSpaceId": "a", "spaces": [
                {"sources": [{"title": "Gone", "textRef": {"sha256": "a".repeat(64), "bytes": 4, "chars": 4}}]}
            ]}),
        );
        for name in [
            "vault-20261101T000000Z.json",
            "vault-20261102T000000Z.json",
            "vault-20261103T000000Z.json",
            "vault-20261104T000000Z.json",
            "vault-20261105T000000Z.json",
            "../vault.json",
            "replaced-20261101T000000Z.json",
        ] {
            assert!(restore_backup(&path, name, now).is_err(), "{name}");
        }
        assert_eq!(revision_of(&path), "live");
        assert!(!folder.join("replaced-20261115T120000Z.json").exists());
    }

    #[test]
    fn a_real_save_backs_up_through_the_vault_writer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.json");
        crate::write_vault_file_if_current(&path, &vault("v1"), None).unwrap();
        crate::write_vault_file_if_current(&path, &vault("v2"), Some("v1")).unwrap();
        let backups = backup_paths(&path);
        assert_eq!(backups.len(), 1);
        assert_eq!(revision_of(&backups[0]), "v1");
        // A rejected stale save changes neither the vault nor its backups.
        assert!(crate::write_vault_file_if_current(&path, &vault("v3"), Some("v1")).is_err());
        assert_eq!(backup_paths(&path).len(), 1);
        assert_eq!(revision_of(&path), "v2");
    }
}
