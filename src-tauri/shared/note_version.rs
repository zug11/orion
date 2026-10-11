//! Preserve the local MCP v1 note fingerprint across the independent/native crates.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

pub fn note_version_fields(fields: Value) -> String {
    let mut hash = DefaultHasher::new();
    fields.to_string().hash(&mut hash);
    format!("v1-{:016x}", hash.finish())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionedNote {
    id: String,
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    concept_ids: Vec<String>,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    pinned: bool,
    color: Option<String>,
}

pub fn note_version(note: &Value) -> Result<String, String> {
    let n: VersionedNote = serde_json::from_value(note.clone())
        .map_err(|_| "The target note has invalid versioned fields.".to_string())?;
    Ok(note_version_fields(json!([
        n.id,
        n.title,
        n.body,
        n.summary,
        n.slug,
        n.aliases,
        n.tags,
        n.source_ids,
        n.concept_ids,
        n.created_at,
        n.updated_at,
        n.pinned,
        n.color
    ])))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_matches_existing_mcp_projection_and_ignores_unrelated_raw_fields() {
        let mut note = json!({"id":"n","title":"🧭","createdAt":"a","updatedAt":"b","lastOpenedAt":"c","unknown":{"retain":true}});
        // Golden outputs captured from the pre-extraction DefaultHasher + JSON-array
        // algorithm in a separate std-only executable, not this helper.
        let expected = "v1-61cf2029a68c0a91";
        assert_eq!(note_version(&json!({"id":"note-1","title":"Title","body":"Body\n🧭","summary":"Summary","slug":"slug","aliases":["alias"],"tags":["tag"],"sourceIds":["source"],"conceptIds":["concept"],"createdAt":"2026-10-01","updatedAt":"2026-10-11","pinned":true,"color":"#ab12ef"})).unwrap(),"v1-232976147d200560");
        let mut explicit_defaults = note.clone();
        for (key, value) in [
            ("body", json!("")),
            ("summary", json!("")),
            ("slug", json!("")),
            ("aliases", json!([])),
            ("tags", json!([])),
            ("sourceIds", json!([])),
            ("conceptIds", json!([])),
            ("pinned", json!(false)),
            ("color", json!(null)),
        ] {
            explicit_defaults[key] = value;
        }
        assert_eq!(note_version(&explicit_defaults).unwrap(), expected);
        assert_eq!(note_version(&note).unwrap(), expected);
        note["lastOpenedAt"] = json!("d");
        assert_eq!(note_version(&note).unwrap(), expected);
        note["body"] = json!("changed");
        assert_ne!(note_version(&note).unwrap(), expected);
        note["tags"] = json!("invalid");
        assert!(note_version(&note).is_err());
    }
}
