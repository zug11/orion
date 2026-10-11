//! Bounded reference-only reads of a live editor. Never edit authority or a persisted version.
use serde::{Deserialize, Serialize};
pub const MAX_CHARS: usize = 12_000;
pub const MAX_FRAGMENTS: usize = 128;
pub const REQUEST_TIMEOUT_MS: u64 = 3_000;
const MAX_POSITION: u64 = 9_007_199_254_740_991;
pub fn identifier(value: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        Err("Editor context identifiers must be exact, nonempty bounded text without control characters.".into())
    } else {
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskView {
    #[default]
    Working,
    History,
}
fn default_chars() -> usize {
    4_000
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EditorContextRequest {
    pub space_id: String,
    pub editor_target_id: String,
    #[serde(default)]
    pub task_view: TaskView,
    #[serde(default = "default_chars")]
    pub max_chars: usize,
}
impl EditorContextRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.editor_target_id, 200)?;
        if self.max_chars == 0 || self.max_chars > MAX_CHARS {
            return Err("max_chars must be between 1 and 12000 Unicode characters.".into());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorContextLookup {
    pub space_id: String,
    pub request_id: String,
}
impl EditorContextLookup {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.request_id, 200)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceState {
    Selected,
    Cursor,
    None,
    Pending,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoordinateSystem {
    DomTextUtf16,
    ProsemirrorPosition,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionRange {
    pub coordinate_system: CoordinateSystem,
    pub from: u64,
    pub to: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceFragment {
    pub text: String,
    pub from: u64,
    pub to: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    Flow,
    Preview,
    NotReady,
    StaleDocument,
    InvalidRange,
    CompletedTask,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorContextReference {
    pub state: ReferenceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionRange>,
    pub fragments: Vec<ReferenceFragment>,
    pub truncated: bool,
    pub omitted_chars: u64,
    pub completed_tasks_omitted: bool,
    pub completed_task_chars: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<UnavailableReason>,
}
impl EditorContextReference {
    pub fn validate(&self, request: &EditorContextRequest) -> Result<(), String> {
        request.validate()?;
        if self.reason.is_some()
            && !matches!(
                self.state,
                ReferenceState::Unavailable | ReferenceState::Pending
            )
        {
            return Err(
                "Only pending or unavailable editor context may give an unavailability reason."
                    .into(),
            );
        }
        if let Some(version) = &self.document_version {
            identifier(version, 200)?;
            if !version.starts_with("displayed-v1:") || version.len() <= "displayed-v1:".len() {
                return Err(
                    "Use the displayed document version, not a persisted note version.".into(),
                );
            }
        }
        let hidden_cursor = self.state == ReferenceState::Unavailable
            && self.reason == Some(UnavailableReason::CompletedTask)
            && request.task_view == TaskView::Working;
        if self.reason == Some(UnavailableReason::CompletedTask) && !hidden_cursor {
            return Err(
                "Completed-task cursor withholding is only available in working view.".into(),
            );
        }
        if self.fragments.len() > MAX_FRAGMENTS
            || self.omitted_chars > MAX_POSITION
            || self.completed_task_chars > self.omitted_chars
            || self.completed_tasks_omitted != (self.completed_task_chars > 0 || hidden_cursor)
            || (request.task_view == TaskView::History && self.completed_tasks_omitted)
        {
            return Err("The editor reference has invalid fragment or omission bounds.".into());
        }
        if let Some(range) = &self.selection {
            if range.from > range.to || range.to > MAX_POSITION {
                return Err("The editor coordinate range is invalid.".into());
            }
        }
        match self.state {
            ReferenceState::Selected => {
                let range = self
                    .selection
                    .as_ref()
                    .ok_or("Selected text needs its exact range.")?;
                if self.document_version.is_none()
                    || range.coordinate_system != CoordinateSystem::DomTextUtf16
                    || range.from == range.to
                    || self.reason.is_some()
                {
                    return Err(
                        "Selected text needs its displayed version and DOM UTF-16 range.".into(),
                    );
                }
                let mut end = range.from;
                let mut chars = 0usize;
                let mut returned_units = 0u64;
                for f in &self.fragments {
                    if f.from < end
                        || f.from >= f.to
                        || f.to > range.to
                        || f.to - f.from != f.text.encode_utf16().count() as u64
                    {
                        return Err(
                            "An editor fragment does not match its exact UTF-16 range.".into()
                        );
                    }
                    chars = chars
                        .checked_add(f.text.chars().count())
                        .ok_or("Editor text is too large.")?;
                    returned_units += f.to - f.from;
                    end = f.to;
                }
                if chars > request.max_chars
                    || chars as u64 + self.omitted_chars > range.to - range.from
                {
                    return Err("The selected text exceeds the requested reference bound.".into());
                }
                let missing_units = range.to - range.from - returned_units;
                if self.omitted_chars > missing_units
                    || self.omitted_chars < missing_units.div_ceil(2)
                {
                    return Err("Omitted character counts do not account for the gaps in the selection range.".into());
                }
                if self.omitted_chars > self.completed_task_chars && !self.truncated {
                    return Err("Unreturned selection text must be marked truncated.".into());
                }
            }
            ReferenceState::Cursor => {
                let range = self
                    .selection
                    .as_ref()
                    .ok_or("A cursor needs its exact position.")?;
                if range.from != range.to
                    || self.document_version.is_none()
                    || self.reason.is_some()
                {
                    return Err("The cursor reference is invalid.".into());
                }
                self.no_text()?;
            }
            _ => {
                if self.selection.is_some() {
                    return Err("An inactive reference cannot contain an editor range.".into());
                }
                self.no_text()?;
            }
        }
        Ok(())
    }
    fn no_text(&self) -> Result<(), String> {
        if !self.fragments.is_empty()
            || self.truncated
            || self.omitted_chars != 0
            || (self.completed_tasks_omitted
                && self.reason != Some(UnavailableReason::CompletedTask))
            || self.completed_task_chars != 0
        {
            Err("Only selected context may contain text or omissions.".into())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn request() -> EditorContextRequest {
        serde_json::from_value(json!({"space_id":"a","editor_target_id":"target","max_chars":2}))
            .unwrap()
    }
    fn selected() -> Value {
        json!({"state":"selected","documentVersion":"displayed-v1:local","selection":{"coordinateSystem":"dom-text-utf16","from":4,"to":7},"fragments":[{"text":"🧭a","from":4,"to":7}],"truncated":false,"omittedChars":0,"completedTasksOmitted":false,"completedTaskChars":0})
    }
    #[test]
    fn editor_context_requests_are_strict_bounded_and_default_to_working() {
        let r = request();
        r.validate().unwrap();
        assert_eq!(r.task_view, TaskView::Working);
        for v in [
            json!({"space_id":" a","editor_target_id":"target"}),
            json!({"space_id":"a","editor_target_id":"target","max_chars":0}),
            json!({"space_id":"a","editor_target_id":"target","max_chars":12001}),
        ] {
            assert!(serde_json::from_value::<EditorContextRequest>(v)
                .unwrap()
                .validate()
                .is_err());
        }
        for v in [
            json!({"space_id":"a","editor_target_id":"target","note_id":"n"}),
            json!({"space_id":"a","editor_target_id":"target","max_chars":1.5}),
            json!({"space_id":"a","editor_target_id":"target","task_view":"all"}),
        ] {
            assert!(serde_json::from_value::<EditorContextRequest>(v).is_err());
        }
    }
    #[test]
    fn editor_context_scalar_budget_and_utf16_positions_are_separate() {
        let mut value = selected();
        let r = request();
        serde_json::from_value::<EditorContextReference>(value.clone())
            .unwrap()
            .validate(&r)
            .unwrap();
        value["fragments"][0]["to"] = json!(6);
        assert!(serde_json::from_value::<EditorContextReference>(value)
            .unwrap()
            .validate(&r)
            .is_err());
        let mut r = request();
        r.max_chars = 1;
        assert!(serde_json::from_value::<EditorContextReference>(selected())
            .unwrap()
            .validate(&r)
            .is_err());
    }
    #[test]
    fn editor_context_rejects_malformed_or_overlapping_fragments_and_extra_text() {
        let mut cases = vec![];
        let mut v = selected();
        v["fragments"] = json!([{"text":"a","from":4,"to":5},{"text":"b","from":4,"to":5}]);
        cases.push(v);
        let mut v = selected();
        v["selection"]["coordinateSystem"] = json!("prosemirror-position");
        cases.push(v);
        let mut v = selected();
        v["selection"]["to"] = json!(9_007_199_254_740_992u64);
        cases.push(v);
        let mut v = selected();
        v["selection"]["to"] = json!(100);
        cases.push(v);
        let mut v = selected();
        v["documentVersion"] = json!("v1-persisted");
        cases.push(v);
        for state in ["cursor", "none", "pending", "unavailable"] {
            let mut v = selected();
            v["state"] = json!(state);
            cases.push(v);
        }
        for value in cases {
            assert!(serde_json::from_value::<EditorContextReference>(value)
                .unwrap()
                .validate(&request())
                .is_err());
        }
    }
    #[test]
    fn editor_context_masked_selection_and_hidden_cursor_have_explicit_semantics() {
        let mut v = selected();
        v["selection"]["to"] = json!(10);
        v["omittedChars"] = json!(3);
        v["completedTaskChars"] = json!(3);
        v["completedTasksOmitted"] = json!(true);
        let reference: EditorContextReference = serde_json::from_value(v).unwrap();
        reference.validate(&request()).unwrap();
        let mut history = request();
        history.task_view = TaskView::History;
        assert!(reference.validate(&history).is_err());
        let cursor:EditorContextReference=serde_json::from_value(json!({"state":"unavailable","reason":"completed-task","fragments":[],"truncated":false,"omittedChars":0,"completedTaskChars":0,"completedTasksOmitted":true})).unwrap();
        cursor.validate(&request()).unwrap();
        assert!(cursor.validate(&history).is_err());
    }
}
