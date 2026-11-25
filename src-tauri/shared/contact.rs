use serde::Serialize;
use serde_json::Value;

// Lexical field order keeps the portable collection hash identical to the browser's.
#[derive(Clone, Serialize)]
pub struct Contact {
    #[serde(skip_serializing_if = "Option::is_none")]
    organization: Option<String>,
    version: u8,
}

pub fn parse(value: &Value) -> Option<Contact> {
    let fields = value.as_object()?;
    if fields.get("version")?.as_f64()? != 1.0
        || fields
            .keys()
            .any(|key| key != "version" && key != "organization")
    {
        return None;
    }
    let organization = match fields.get("organization") {
        Some(value) => {
            let label = value.as_str()?;
            if label.is_empty()
                || label.encode_utf16().count() > 200
                || label.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}') != label
                || label
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
            {
                return None;
            }
            Some(label.to_owned())
        }
        None => None,
    };
    Some(Contact {
        organization,
        version: 1,
    })
}

pub fn validate_vault(vault: &Value) -> Result<(), String> {
    let spaces = vault["spaces"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(vault.get("workspace").map(|_| vault));
    for space in spaces {
        for note in space["notes"].as_array().into_iter().flatten() {
            if note
                .get("contact")
                .is_some_and(|contact| parse(contact).is_none())
            {
                return Err("Invalid contact metadata.".into());
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
    fn contact_metadata_is_optional_and_validated_for_both_vault_shapes() {
        let mut space = json!({"workspace": {}, "notes": [{"kind": "person"}]});
        assert!(validate_vault(&space).is_ok());
        space["notes"][0]["contact"] = json!({"version": 1, "organization": "Studio 株式会社"});
        assert!(validate_vault(&json!({"spaces": [space]})).is_ok());
        for invalid in [
            json!(null),
            json!({"version": 2}),
            json!({"version": 1, "private": 42}),
            json!({"version": 1, "organization": null}),
            json!({"version": 1, "organization": "x\ny"}),
            json!({"version": 1, "organization": "😀".repeat(101)}),
        ] {
            space["notes"][0]["contact"] = invalid;
            assert!(validate_vault(&space).is_err());
            assert!(validate_vault(&json!({"spaces": [space]})).is_err());
        }
    }
}
