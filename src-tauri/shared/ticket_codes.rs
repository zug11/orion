//! Space-local identity metadata. The note remains the only work-item store.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub fn validate(value: &Value) -> Result<(), String> {
    let prefix = value["prefix"].as_str().unwrap_or("");
    let next = value["nextNumber"].as_u64().unwrap_or(0);
    let assigned = value["assigned"]
        .as_object()
        .ok_or("Invalid ticket codes.")?;
    if value["version"] != 1
        || !(2..=12).contains(&prefix.len())
        || !prefix.as_bytes()[0].is_ascii_uppercase()
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        || !(1..=999_999_999).contains(&next)
        || assigned.len() > 100_000
    {
        return Err("Invalid ticket codes.".into());
    }
    let mut used = BTreeSet::new();
    if let Some(prefixes) = value.get("assignedPrefixes") {
        let prefixes = prefixes
            .as_object()
            .ok_or("Invalid ticket code prefixes.")?;
        for (id, prefix) in prefixes {
            let prefix = prefix.as_str().unwrap_or("");
            if !assigned.contains_key(id)
                || !(2..=12).contains(&prefix.len())
                || !prefix.as_bytes()[0].is_ascii_uppercase()
                || !prefix
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                return Err("Invalid ticket code prefix.".into());
            }
        }
    }
    for (id, number) in assigned {
        let number = number.as_u64().ok_or("Invalid ticket code number.")?;
        if id.is_empty()
            || id.len() > 96
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || number == 0
            || number >= next
            || !used.insert(number)
        {
            return Err("Duplicate or invalid ticket codes.".into());
        }
    }
    Ok(())
}

pub fn code(value: &Value, id: &str) -> Option<String> {
    Some(format!(
        "{}-{:03}",
        value["assignedPrefixes"][id]
            .as_str()
            .or_else(|| value["prefix"].as_str())?,
        value["assigned"][id].as_u64()?
    ))
}

/// The caller holds the vault lock; the supplied IDs are parsed actual tasks.
pub fn allocate(
    value: Option<&Value>,
    ids: impl IntoIterator<Item = String>,
) -> Result<Value, String> {
    let mut ledger = value
        .cloned()
        .unwrap_or_else(|| json!({"version":1,"prefix":"ORION","nextNumber":1,"assigned":{}}));
    validate(&ledger)?;
    let mut counts = BTreeMap::new();
    for id in ids {
        *counts.entry(id).or_insert(0usize) += 1;
    }
    let mut next = ledger["nextNumber"].as_u64().unwrap();
    let assigned = ledger["assigned"].as_object_mut().unwrap();
    for (id, count) in counts {
        if count != 1 || assigned.contains_key(&id) {
            continue;
        }
        if assigned.len() >= 100_000 || next >= 999_999_999 {
            return Err("This Space has reached its ticket-code limit.".into());
        }
        assigned.insert(id, json!(next));
        next += 1;
    }
    ledger["nextNumber"] = json!(next);
    validate(&ledger)?;
    Ok(ledger)
}

pub fn validate_vault(value: &Value) -> Result<(), String> {
    for space in value["spaces"].as_array().into_iter().flatten() {
        if let Some(codes) = space.get("ticketCodes") {
            validate(codes)?;
        }
    }
    Ok(())
}

/// Older/stale writers cannot erase or renumber already published identities.
pub fn validate_transition(before: Option<&Value>, after: &Value) -> Result<(), String> {
    validate_vault(after)?;
    for space in after["spaces"].as_array().into_iter().flatten() {
        let old = before
            .and_then(|v| v["spaces"].as_array())
            .and_then(|spaces| {
                spaces
                    .iter()
                    .find(|s| s["workspace"]["id"] == space["workspace"]["id"])
            });
        if let Some(codes) = old.and_then(|s| s.get("ticketCodes")) {
            validate(codes)?;
            let next = &space["ticketCodes"];
            if next["nextNumber"].as_u64().unwrap_or(0) < codes["nextNumber"].as_u64().unwrap_or(0)
                || codes["assigned"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .any(|(id, number)| {
                        next["assigned"].get(id) != Some(number)
                            || code(codes, id) != code(next, id)
                    })
            {
                return Err("Ticket codes changed outside this window. Reload the current library before saving.".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configurable_prefix_only_changes_new_codes() {
        let first = allocate(None, ["a".into()]).unwrap();
        let before = json!({"spaces":[{"workspace":{"id":"s"},"ticketCodes":first}]});
        let mut next = before.clone();
        next["spaces"][0]["ticketCodes"]["prefix"] = json!("TEAM");
        assert!(validate_transition(Some(&before), &next).is_err());
        next["spaces"][0]["ticketCodes"]["assignedPrefixes"] = json!({"a":"ORION"});
        assert!(validate_transition(Some(&before), &next).is_ok());
        let assigned = allocate(
            Some(&next["spaces"][0]["ticketCodes"]),
            ["a".into(), "b".into()],
        )
        .unwrap();
        assert_eq!(code(&assigned, "a"), Some("ORION-001".into()));
        assert_eq!(code(&assigned, "b"), Some("TEAM-002".into()));
    }
    #[test]
    fn codes_are_stable_and_deleted_numbers_are_reserved() {
        let first = allocate(
            None,
            [
                "b".into(),
                "a".into(),
                "duplicate".into(),
                "duplicate".into(),
            ],
        )
        .unwrap();
        assert_eq!(code(&first, "a"), Some("ORION-001".into()));
        assert_eq!(code(&first, "duplicate"), None);
        let next = allocate(Some(&first), ["b".into(), "c".into()]).unwrap();
        assert_eq!(code(&next, "a"), Some("ORION-001".into()));
        assert_eq!(code(&next, "c"), Some("ORION-003".into()));
    }
    #[test]
    fn rejects_duplicate_numbers_and_erasing_published_codes() {
        assert!(validate(
            &json!({"version":1,"prefix":"ORION","nextNumber":3,"assigned":{"a":1,"b":1}})
        )
        .is_err());
        let codes = allocate(None, ["a".into()]).unwrap();
        let old = json!({"spaces":[{"workspace":{"id":"s"},"ticketCodes":codes}]});
        assert!(
            validate_transition(Some(&old), &json!({"spaces":[{"workspace":{"id":"s"}}]})).is_err()
        );
        assert!(validate_transition(Some(&old), &old).is_ok());
    }
}
