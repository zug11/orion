use serde_json::Value;
pub fn validate_vault(value: &Value) -> Result<(), String> {
    for space in value["spaces"].as_array().into_iter().flatten() {
        if let Some(identity) = space.get("portableImport") {
            let export = identity["exportId"].as_str().unwrap_or("");
            let hash = identity["collectionHash"].as_str().unwrap_or("");
            if identity["version"] != 1
                || identity.as_object().map(|v| v.len()) != Some(3)
                || !(16..=64).contains(&export.len())
                || !export
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || hash.len() != 64
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || space["workspace"]["id"].as_str()
                    != Some(format!("space-portable-{export}").as_str())
            {
                return Err("Invalid portable collection identity.".into());
            }
        }
    }
    Ok(())
}
pub fn validate_transition(before: Option<&Value>, after: &Value) -> Result<(), String> {
    validate_vault(after)?;
    for space in after["spaces"].as_array().into_iter().flatten() {
        if let Some(old) = before.and_then(|v| v["spaces"].as_array()).and_then(|s| {
            s.iter()
                .find(|s| s["workspace"]["id"] == space["workspace"]["id"])
        }) {
            if old.get("portableImport").is_some()
                && old.get("portableImport") != space.get("portableImport")
            {
                return Err(
                    "A portable collection's identity cannot change while saving edits.".into(),
                );
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn collection_identity_is_bounded_and_immutable() {
        let first = json!({"spaces":[{"workspace":{"id":"space-portable-collection_123456"},"portableImport":{"version":1,"exportId":"collection_123456","collectionHash":"a".repeat(64)}}]});
        assert!(validate_vault(&first).is_ok());
        let mut next = first.clone();
        next["spaces"][0]["portableImport"]["collectionHash"] = json!("b".repeat(64));
        assert!(validate_transition(Some(&first), &next).is_err());
        next["spaces"][0]["portableImport"] =
            json!({"version":1,"exportId":"../outside","collectionHash":"a".repeat(64)});
        assert!(validate_vault(&next).is_err());
    }
}
