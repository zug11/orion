//! Explicit external edit proposals. These are review requests, never write authority.
use serde::{Deserialize, Serialize};

pub const MAX_REVIEW_EDITS: usize = 8;
pub const MAX_EDIT_CHARS: usize = 6_000;
pub const MAX_TOTAL_EDIT_CHARS: usize = 24_000;
pub const MAX_REWRITE_CHARS: usize = 24_000;
pub const MAX_REVIEW_BODY_BYTES: usize = 2_000_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewTextEdit {
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReviewEdit {
    Focused { edits: Vec<ReviewTextEdit> },
    Rewrite { body: String },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewTaskView {
    #[default]
    Working,
    History,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewSubmitRequest {
    pub space_id: String,
    pub request_id: String,
    pub review_target_id: String,
    pub note_id: String,
    pub expected_version: String,
    #[serde(default)]
    pub task_view: ReviewTaskView,
    pub edit: ReviewEdit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewLookupRequest {
    pub space_id: String,
    pub review_id: String,
}

pub fn identifier(value: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        Err("Review identifiers must be nonempty, bounded text without control characters.".into())
    } else {
        Ok(())
    }
}

/// Only a gate for whole-body replacement: no task text is returned to MCP.
/// Match the existing working view's frontmatter, fenced-code and checklist rules.
pub fn contains_completed_task(body: &str) -> bool {
    let lines: Vec<_> = body.lines().collect();
    let front_end = if lines.first().is_some_and(|line| line.trim() == "---") {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| matches!(line.trim(), "---" | "..."))
            .map(|(i, _)| i)
    } else {
        None
    };
    let mut fence: Option<(char, usize)> = None;
    for (index, line) in lines.iter().enumerate() {
        if front_end.is_some_and(|end| index <= end) {
            continue;
        }
        let text = line.trim_start();
        let indent = line.len() - text.len();
        if indent <= 3 && (text.starts_with('`') || text.starts_with('~')) {
            let marker = text.chars().next().unwrap();
            let width = text.chars().take_while(|c| *c == marker).count();
            if width >= 3 {
                if let Some((current, count)) = fence {
                    if current == marker && width >= count && text[width..].trim().is_empty() {
                        fence = None;
                    }
                } else if marker != '`' || !text[width..].contains('`') {
                    fence = Some((marker, width));
                }
                continue;
            }
        }
        if fence.is_some() {
            continue;
        }
        if let Some(rest) = text.strip_prefix(['-', '+', '*']) {
            if !rest.starts_with([' ', '\t']) {
                continue;
            }
            let rest = rest.trim_start_matches([' ', '\t']);
            if let Some(rest) = rest
                .strip_prefix("[x]")
                .or_else(|| rest.strip_prefix("[X]"))
            {
                if rest.starts_with([' ', '\t']) && !rest.trim().is_empty() {
                    return true;
                }
            }
        }
    }
    false
}

fn valid_text(text: &str) -> bool {
    !text
        .chars()
        .any(|c| (c < ' ' && !['\n', '\r', '\t'].contains(&c)) || c == '\u{7f}')
}

impl ReviewSubmitRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.request_id, 128)?;
        identifier(&self.review_target_id, 200)?;
        identifier(&self.note_id, 200)?;
        identifier(&self.expected_version, 64)?;
        match &self.edit {
            ReviewEdit::Focused { edits } => {
                if edits.is_empty() || edits.len() > MAX_REVIEW_EDITS {
                    return Err("A focused proposal requires one to eight edits.".into());
                }
                let mut total = 0;
                for edit in edits {
                    if edit.before.trim().is_empty() || edit.before == edit.after {
                        return Err("Each edit needs a nonempty original passage and a different replacement.".into());
                    }
                    for text in [&edit.before, &edit.after] {
                        let length = text.chars().count();
                        total += length;
                        let compact = text
                            .chars()
                            .filter(|c| !c.is_whitespace())
                            .collect::<String>()
                            .to_lowercase();
                        if length > MAX_EDIT_CHARS
                            || total > MAX_TOTAL_EDIT_CHARS
                            || !valid_text(text)
                            || compact.contains("<!--orion-")
                            || compact.contains("<!--/orion-")
                        {
                            return Err("Focused edits exceed the review bounds or contain protected control text.".into());
                        }
                    }
                }
            }
            ReviewEdit::Rewrite { body } => {
                if body.trim().is_empty()
                    || body.chars().count() > MAX_REWRITE_CHARS
                    || !valid_text(body)
                {
                    return Err(
                        "A rewrite requires nonempty text within the 24000-character review limit."
                            .into(),
                    );
                }
            }
        }
        Ok(())
    }
}

impl ReviewLookupRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.review_id, 200)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn review_contract_is_strict_and_uses_unicode_character_bounds() {
        let value = json!({"space_id":"s","request_id":"r","review_target_id":"t","note_id":"n","expected_version":"v1-x","edit":{"kind":"focused","edits":[{"before":"old","after":"🧭".repeat(6000)}]}});
        let request: ReviewSubmitRequest = serde_json::from_value(value.clone()).unwrap();
        assert!(request.validate().is_ok());
        let mut invalid = value.clone();
        invalid["edit"]["edits"][0]["after"] = json!("🧭".repeat(6001));
        assert!(serde_json::from_value::<ReviewSubmitRequest>(invalid)
            .unwrap()
            .validate()
            .is_err());
        for extra in ["accept", "base_body", "title", "model"] {
            let mut invalid = value.clone();
            invalid[extra] = json!(true);
            assert!(serde_json::from_value::<ReviewSubmitRequest>(invalid).is_err());
        }
        let mut invalid = value;
        invalid["edit"]["note_id"] = json!("elsewhere");
        assert!(serde_json::from_value::<ReviewSubmitRequest>(invalid).is_err());
    }
    #[test]
    fn historical_task_gate_ignores_frontmatter_and_fences_but_preserves_completed_actions() {
        for body in [
            "- [x] Done",
            "* [X] Done\r\n",
            "  + [x] 🧭",
            "```\nexample\n```\n- [x] Done",
        ] {
            assert!(contains_completed_task(body), "{body}");
        }
        for body in [
            "- [ ] Open",
            "---\n- [x] frontmatter\n---\nProse",
            "```\r\n- [x] Example\r\n```\r\n",
            "~~~~lang\n- [x] Example\n~~~~",
            "- [x] ",
        ] {
            assert!(!contains_completed_task(body), "{body}");
        }
    }
}
