//! Finite selected-editor generation. Captures confer proposal authority, never acceptance.
use serde::{Deserialize, Serialize};

pub const REQUEST_TIMEOUT_MS: u64 = 3_000;
pub const MAX_INSTRUCTION_CHARS: usize = 1_250;
pub const MAX_BODY_BYTES: usize = 2_000_000;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub fn identifier(value: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        Err(
            "Editor action identifiers must be exact bounded text without control characters."
                .into(),
        )
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteAmount {
    Sentence,
    Paragraph,
    Section,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RewritePreset {
    Rewrite,
    Clarify,
    Tighten,
    Simplify,
    Expand,
    Enrich,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageQuality {
    Fast,
    Detailed,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageContext {
    Selection,
    Space,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum EditorAction {
    Write {
        amount: WriteAmount,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instruction: Option<String>,
    },
    Rewrite {
        preset: RewritePreset,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instruction: Option<String>,
    },
    Image {
        quality: ImageQuality,
        context: ImageContext,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instruction: Option<String>,
    },
}
impl EditorAction {
    pub fn validate(&self) -> Result<(), String> {
        let instruction = match self {
            Self::Write { instruction, .. }
            | Self::Rewrite { instruction, .. }
            | Self::Image { instruction, .. } => instruction,
        };
        if instruction.as_ref().is_some_and(|s| {
            s.chars().count() > MAX_INSTRUCTION_CHARS
                || s.chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        }) {
            return Err("Editor instructions are limited to 1250 Unicode characters without unsupported controls.".into());
        }
        Ok(())
    }
    pub fn uses_space_context(&self) -> bool {
        matches!(
            self,
            Self::Image {
                context: ImageContext::Space,
                ..
            } | Self::Rewrite {
                preset: RewritePreset::Enrich,
                ..
            }
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureRequest {
    pub space_id: String,
    pub note_id: String,
    pub editor_target_id: String,
    pub request_id: String,
    pub action: EditorAction,
}
impl CaptureRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.note_id, 200)?;
        identifier(&self.editor_target_id, 200)?;
        identifier(&self.request_id, 128)?;
        self.action.validate()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    pub space_id: String,
    pub note_id: String,
    pub editor_target_id: String,
    pub capture_id: String,
    pub expected_document_version: String,
    pub request_id: String,
}
impl StartRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.note_id, 200)?;
        identifier(&self.editor_target_id, 200)?;
        identifier(&self.capture_id, 200)?;
        identifier(&self.expected_document_version, 200)?;
        identifier(&self.request_id, 128)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LookupRequest {
    pub space_id: String,
    pub action_id: String,
}
impl LookupRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.action_id, 200)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorActionGrant {
    pub action_id: String,
    pub session_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RichRange {
    pub coordinate_system: String,
    pub from: u64,
    pub to: u64,
}
impl RichRange {
    pub fn validate(&self) -> Result<(), String> {
        if self.coordinate_system != "prosemirror"
            || self.from > self.to
            || self.to > MAX_SAFE_INTEGER
        {
            Err("An exact bounded ProseMirror range is required.".into())
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionState {
    CapturePending,
    Captured,
    Submitted,
    Generating,
    AwaitingReview,
    Accepting,
    AcceptedInEditor,
    Saved,
    Cancelled,
    Discarded,
    Stale,
    Failed,
    SaveFailed,
}
impl ActionState {
    pub fn before_decision(&self) -> bool {
        matches!(
            self,
            Self::CapturePending
                | Self::Captured
                | Self::Submitted
                | Self::Generating
                | Self::AwaitingReview
        )
    }
    pub fn pending(&self) -> bool {
        self.before_decision() || matches!(self, Self::Accepting | Self::AcceptedInEditor)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStage {
    Writing,
    ImagePlanning,
    ImageRendering,
    ImageSaving,
    Publish,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedResult {
    pub note_id: String,
    pub version: String,
    pub url: String,
    pub citation: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub id: String,
    pub space_id: String,
    pub note_id: String,
    pub editor_target_id: String,
    pub state: ActionState,
    pub action: EditorAction,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<RichRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_target: Option<RichRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<ActionStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<SavedResult>,
}
pub fn saved_note_url(space: &str, note: &str) -> String {
    fn form(value: &str) -> String {
        let mut output = String::new();
        for byte in value.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                    output.push(byte as char)
                }
                b' ' => output.push('+'),
                _ => output.push_str(&format!("%{byte:02X}")),
            }
        }
        output
    }
    format!(
        "orion://open?space_id={}&note_id={}",
        form(space),
        form(note)
    )
}
impl Receipt {
    pub fn validate(&self) -> Result<(), String> {
        for value in [
            &self.id,
            &self.space_id,
            &self.note_id,
            &self.editor_target_id,
        ] {
            identifier(value, 200)?;
        }
        self.action.validate()?;
        if self.created_at > MAX_SAFE_INTEGER
            || self.updated_at < self.created_at
            || self.updated_at > MAX_SAFE_INTEGER
        {
            return Err("Invalid editor receipt timestamps.".into());
        }
        if let Some(id) = &self.capture_id {
            identifier(id, 200)?;
        }
        if let Some(version) = &self.document_version {
            identifier(version, 200)?;
        }
        for range in [&self.selection, &self.effective_target]
            .into_iter()
            .flatten()
        {
            range.validate()?;
        }
        let metadata = [
            self.capture_id.is_some(),
            self.document_version.is_some(),
            self.selection.is_some(),
            self.effective_target.is_some(),
        ];
        if metadata.iter().any(|v| *v) && metadata.iter().any(|v| !*v) {
            return Err("Editor capture metadata is incomplete.".into());
        }
        if matches!(
            self.state,
            ActionState::Captured
                | ActionState::Submitted
                | ActionState::Generating
                | ActionState::AwaitingReview
                | ActionState::Accepting
                | ActionState::AcceptedInEditor
                | ActionState::Saved
                | ActionState::SaveFailed
        ) && !metadata[0]
        {
            return Err("A claimed editor action requires native capture metadata.".into());
        }
        if self
            .error
            .as_ref()
            .is_some_and(|s| s.chars().count() > 1_000)
        {
            return Err("Editor receipt error exceeds its bound.".into());
        }
        if let Some(result) = &self.result {
            if self.state != ActionState::Saved || result.note_id != self.note_id {
                return Err("Only a verified saved receipt may carry a note result.".into());
            }
            identifier(&result.version, 200)?;
            identifier(&result.url, 1_000)?;
            if result.url != saved_note_url(&self.space_id, &self.note_id)
                || !result.citation.starts_with('[')
                || !result.citation.ends_with(&format!("]({})", result.url))
                || result.citation.chars().count() > 2_000
            {
                return Err("Invalid saved note reference.".into());
            }
        } else if self.state == ActionState::Saved {
            return Err("Saved editor receipt requires a disk-confirmed result.".into());
        }
        Ok(())
    }
    // The independent MCP crate validates exact response identity with this method.
    #[allow(dead_code)]
    pub fn validate_capture(&self, request: &CaptureRequest) -> Result<(), String> {
        self.validate()?;
        if self.space_id != request.space_id
            || self.note_id != request.note_id
            || self.editor_target_id != request.editor_target_id
            || self.action != request.action
        {
            Err("The editor capture reply changed its exact requested scope or action.".into())
        } else {
            Ok(())
        }
    }
    // The independent MCP crate validates exact response identity with this method.
    #[allow(dead_code)]
    pub fn validate_start(&self, request: &StartRequest) -> Result<(), String> {
        self.validate()?;
        if self.space_id != request.space_id
            || self.note_id != request.note_id
            || self.editor_target_id != request.editor_target_id
            || self.capture_id.as_deref() != Some(&request.capture_id)
            || self.document_version.as_deref() != Some(&request.expected_document_version)
        {
            Err("The editor start reply changed its exact capture or target.".into())
        } else {
            Ok(())
        }
    }
    // The independent MCP crate validates exact response identity with this method.
    #[allow(dead_code)]
    pub fn validate_lookup(&self, request: &LookupRequest) -> Result<(), String> {
        self.validate()?;
        if self.space_id != request.space_id || self.id != request.action_id {
            Err("The editor receipt changed its exact lookup identity.".into())
        } else {
            Ok(())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn editor_action_protocol_is_strict_and_unicode_bounded() {
        let v = json!({"space_id":"s","note_id":"n","editor_target_id":"t","request_id":"r","action":{"kind":"write","amount":"paragraph","instruction":"🧭".repeat(1250)}});
        assert!(serde_json::from_value::<CaptureRequest>(v.clone())
            .unwrap()
            .validate()
            .is_ok());
        for field in ["accept", "selected_text", "model", "from", "base_body"] {
            let mut x = v.clone();
            x[field] = json!(true);
            assert!(serde_json::from_value::<CaptureRequest>(x).is_err());
        }
        let mut x = v.clone();
        x["action"]["instruction"] = json!("🧭".repeat(1251));
        assert!(serde_json::from_value::<CaptureRequest>(x)
            .unwrap()
            .validate()
            .is_err());
        let mut x = v;
        x["action"]["target"] = json!("other");
        assert!(serde_json::from_value::<CaptureRequest>(x).is_err());
        assert!(serde_json::from_value::<LookupRequest>(
            json!({"space_id":"s","action_id":"a","accept":true})
        )
        .is_err());
    }
}
