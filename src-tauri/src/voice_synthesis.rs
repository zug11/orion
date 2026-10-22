//! A read-only consolidation pass, separate from the live speaking connection.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub fn protocol() -> Value {
    serde_json::from_str(include_str!("../../src/lib/voiceSynthesisProtocol.json"))
        .expect("the voice synthesis protocol is valid")
}
pub const ERROR: &str = "The voice finding summary could not be prepared. Research remains in the work summary. (VOICE_SYNTHESIS)";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    space_id: String,
    conversation: String,
    previous_offers: Vec<String>,
    findings: Vec<Finding>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Finding {
    key: String,
    id: String,
    revision: u64,
    sequence: u64,
    subject: String,
    question: String,
    finding: String,
    provenance: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Summary {
    reply: String,
    included: Vec<String>,
    deferred: Vec<String>,
}
fn bounded(text: &str, max: usize, required: bool) -> bool {
    text.chars().count() <= max && (!required || !text.trim().is_empty())
}
pub fn validate_context(raw: Option<&str>) -> Result<Context, String> {
    let raw = raw.filter(|s| s.len() <= 32_000).ok_or(ERROR)?;
    let context: Context = serde_json::from_str(raw).map_err(|_| ERROR)?;
    if !bounded(&context.space_id, 200, true)
        || !bounded(&context.conversation, 4_000, false)
        || context.previous_offers.len() > 3
        || context
            .previous_offers
            .iter()
            .any(|s| !bounded(s, 900, false))
        || context.findings.is_empty()
        || context.findings.len() > 4
    {
        return Err(ERROR.into());
    }
    let mut seen = HashSet::new();
    for (index, finding) in context.findings.iter().enumerate() {
        if finding.key != format!("f{}", index + 1)
            || !bounded(&finding.id, 200, true)
            || !seen.insert(&finding.id)
            || finding.revision == 0
            || finding.sequence == 0
            || finding.revision > 9_007_199_254_740_991
            || finding.sequence > 9_007_199_254_740_991
            || !bounded(&finding.subject, 120, false)
            || !bounded(&finding.question, 600, false)
            || !bounded(&finding.finding, 6_000, true)
            || !bounded(&finding.provenance, 8_000, true)
        {
            return Err(ERROR.into());
        }
        let provenance: Value = serde_json::from_str(&finding.provenance).map_err(|_| ERROR)?;
        if provenance["spaceId"].as_str() != Some(context.space_id.as_str()) {
            return Err(ERROR.into());
        }
    }
    Ok(context)
}
pub fn parse_result(raw: &str, context: &Context) -> Result<super::ChatResult, String> {
    let mut result: Summary = serde_json::from_str(raw).map_err(|_| ERROR)?;
    let keys: Vec<_> = result.included.iter().chain(&result.deferred).collect();
    let seen: HashSet<_> = keys.iter().copied().collect();
    if !bounded(&result.reply, 900, false)
        || result.reply.trim().is_empty() != result.included.is_empty()
        || keys.len() != context.findings.len()
        || seen.len() != keys.len()
        || context.findings.iter().any(|f| !seen.contains(&f.key))
    {
        return Err(ERROR.into());
    }
    result.reply = result.reply.trim().to_string();
    Ok(super::ChatResult {
        reply: String::new(),
        synthesis: Some(result),
        suggestions: None,
        note_actions: Vec::new(),
        note_edits: Vec::new(),
        note_rewrite: None,
        edit_intent: None,
        read_requests: None,
        checkpoint: None,
        voice: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Value {
        json!({"spaceId":"space", "conversation":"user: Compare the findings", "previousOffers":[],
            "findings":[{"key":"f1", "id":"worker", "revision":1, "sequence":2,
                "subject":"Question", "question":"Compare", "finding":"Evidence with a caveat.",
                "provenance":"{\"spaceId\":\"space\",\"limited\":true}"}]})
    }
    #[test]
    fn validates_read_only_results_and_exact_finding_partition() {
        let context = validate_context(Some(&fixture().to_string())).unwrap();
        let result = parse_result(
            r#"{"reply":"Evidence, with a caveat.","included":["f1"],"deferred":[]}"#,
            &context,
        )
        .unwrap();
        assert!(result.note_actions.is_empty());
        assert!(result.note_edits.is_empty());
        assert!(result.read_requests.is_none());
        assert!(parse_result(r#"{"reply":"","included":[],"deferred":["f1"]}"#, &context).is_ok());
        for value in [
            json!({"reply":"x","included":["f2"],"deferred":[]}),
            json!({"reply":"x","included":["f1"],"deferred":["f1"]}),
            json!({"reply":"","included":["f1"],"deferred":[]}),
            json!({"reply":"x","included":[],"deferred":["f1"]}),
            json!({"reply":"x".repeat(901),"included":["f1"],"deferred":[]}),
            json!({"reply":"x","included":["f1"],"deferred":[],"noteActions":[]}),
        ] {
            assert!(parse_result(&value.to_string(), &context).is_err());
        }
    }
    #[test]
    fn rejects_unbounded_duplicate_and_cross_space_context() {
        for (path, value) in [
            ("/spaceId", json!("")),
            ("/conversation", json!("x".repeat(4001))),
            ("/findings/0/key", json!("f2")),
            ("/findings/0/sequence", json!(0)),
            ("/findings/0/revision", json!(1.5)),
            ("/findings/0/finding", json!("x".repeat(6001))),
            ("/findings/0/provenance", json!("{\"spaceId\":\"other\"}")),
        ] {
            let mut data = fixture();
            *data.pointer_mut(path).unwrap() = value;
            assert!(validate_context(Some(&data.to_string())).is_err());
        }
        let mut data = fixture();
        let mut second = data["findings"][0].clone();
        second["key"] = json!("f2");
        data["findings"].as_array_mut().unwrap().push(second);
        assert!(validate_context(Some(&data.to_string())).is_err());
        assert!(validate_context(Some(&" ".repeat(32_001))).is_err());
        assert_eq!(protocol()["schema"]["additionalProperties"], false);
    }
}
