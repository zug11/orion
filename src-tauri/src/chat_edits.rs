use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn protocol() -> Value {
    serde_json::from_str(include_str!("../../src/lib/chatEditsProtocol.json"))
        .expect("the bundled Chat editing protocol is valid JSON")
}

pub fn parse_intent(value: Option<Value>) -> Result<String, ()> {
    match value {
        None => Ok("none".to_string()),
        Some(Value::String(intent))
            if ["none", "focused", "rewrite"].contains(&intent.as_str()) =>
        {
            Ok(intent)
        }
        _ => Err(()),
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChatNoteEdit {
    before: String,
    after: String,
}

pub fn parse(value: Option<Value>) -> Result<Vec<ChatNoteEdit>, ()> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let edits: Vec<ChatNoteEdit> = serde_json::from_value(value).map_err(|_| ())?;
    if edits.len() > 8 {
        return Err(());
    }
    let mut total = 0;
    for edit in &edits {
        if edit.before.trim().is_empty() || edit.before == edit.after {
            return Err(());
        }
        for text in [&edit.before, &edit.after] {
            let count = text.chars().count();
            total += count;
            let compact = text
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
                .to_lowercase();
            if count > 6_000
                || total > 24_000
                || compact.contains("<!--orion-")
                || compact.contains("<!--/orion-")
                || text
                    .chars()
                    .any(|c| (c < ' ' && !['\n', '\r', '\t'].contains(&c)) || c == '\u{7f}')
            {
                return Err(());
            }
        }
    }
    Ok(edits)
}

pub fn parse_rewrite(value: Option<Value>) -> Result<Option<String>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = value.as_str().ok_or(())?;
    if text.chars().count() > 24_000
        || text
            .chars()
            .any(|c| (c < ' ' && !['\n', '\r', '\t'].contains(&c)) || c == '\u{7f}')
    {
        return Err(());
    }
    Ok(Some(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn proposal_intent_is_a_bounded_plan_not_write_authority() {
        assert_eq!(parse_intent(None).unwrap(), "none");
        for intent in ["none", "focused", "rewrite"] {
            assert_eq!(parse_intent(Some(json!(intent))).unwrap(), intent);
        }
        for invalid in [json!("apply"), json!(true), json!({"noteId":"foreign"})] {
            assert!(parse_intent(Some(invalid)).is_err());
        }
    }
    #[test]
    fn proposals_are_exact_bounded_text_without_destination_or_control_fields() {
        assert!(parse(Some(
            json!([{"before":"Old sentence.","after":"New sentence."}])
        ))
        .is_ok());
        for invalid in [
            json!([{"before":"","after":"Text"}]),
            json!([{"before":"Old","after":"Old"}]),
            json!([{"before":"Old","after":"New","noteId":"foreign"}]),
            json!([{"before":"Old","after":"<!-- orion-block:v1 -->"}]),
            json!([{"before":"Old","after":"x".repeat(6001)}]),
        ] {
            assert!(parse(Some(invalid)).is_err());
        }
    }
}
