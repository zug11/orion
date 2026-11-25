//! Optional, host-recorded writing provenance. A note without the field predates
//! provenance or has no recorded contribution from Orion AI or an MCP client.
use serde_json::{json, Map, Value};

pub fn is_valid(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| match items.as_slice() {
            [one] => matches!(one.as_str(), Some("orion-ai" | "mcp")),
            [first, second] => first == "orion-ai" && second == "mcp",
            _ => false,
        })
}

pub fn mark_note(note: &mut Map<String, Value>, origin: &str) -> Result<(), String> {
    if !matches!(origin, "mcp" | "orion-ai") {
        return Err("Unknown note writing origin.".into());
    }
    let updated = if let Some(value) = note.get("writingOrigins") {
        if !is_valid(value) {
            return Err("Invalid note writing origins.".into());
        }
        if value[0] == origin || value[1] == origin {
            return Ok(());
        }
        json!(["orion-ai", "mcp"])
    } else {
        json!([origin])
    };
    note.insert("writingOrigins".into(), updated);
    Ok(())
}

fn spaces(vault: &Value) -> impl Iterator<Item = &Value> {
    vault["spaces"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(vault.get("workspace").map(|_| vault))
}

/// A user can undo an accepted insertion from either origin. The writer that
/// owns an editor transaction decides whether it introduced that origin.
pub fn validate_vault(vault: &Value) -> Result<(), String> {
    for space in spaces(vault) {
        for note in space["notes"].as_array().into_iter().flatten() {
            if note
                .get("writingOrigins")
                .is_some_and(|value| !is_valid(value))
            {
                return Err("Invalid note writing origins.".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_union_and_optional_metadata() {
        let mut note = json!({"id":"n"}).as_object().unwrap().clone();
        mark_note(&mut note, "mcp").unwrap();
        mark_note(&mut note, "orion-ai").unwrap();
        mark_note(&mut note, "mcp").unwrap();
        assert_eq!(note["writingOrigins"], json!(["orion-ai", "mcp"]));
        let mut vault = json!({"spaces":[{"workspace":{"id":"s"},"notes":[note]}]});
        assert!(validate_vault(&vault).is_ok());
        vault["spaces"][0]["notes"][0]
            .as_object_mut()
            .unwrap()
            .remove("writingOrigins");
        assert!(validate_vault(&vault).is_ok());
        for value in [
            json!(null),
            json!([]),
            json!(["mcp", "orion-ai"]),
            json!(["mcp", "mcp"]),
            json!(["human"]),
        ] {
            vault["spaces"][0]["notes"][0]["writingOrigins"] = value;
            assert!(validate_vault(&vault).is_err());
        }
    }
}
