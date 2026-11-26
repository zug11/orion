//! Only an already-rendered in-memory PNG crosses this provider boundary.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};

const PREFIX: &str = "data:image/png;base64,";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    png: String,
    pub(super) drawing: Value,
}

impl Input {
    pub(super) fn validate(&self, source: &str) -> Result<(), String> {
        let invalid =
            || "Visual review requires a locally rendered PNG of up to 960 pixels.".to_owned();
        if self.png.len() > 2_000_000 || self.drawing.to_string().len() > 48_000 {
            return Err(invalid());
        }
        super::visual_input::illustration::validate(&self.drawing)?;
        if !self.drawing["passage"]
            .as_str()
            .is_some_and(|passage| source.contains(passage))
        {
            return Err("The drawing differs from the passage selected for review.".into());
        }
        let bytes = STANDARD
            .decode(self.png.strip_prefix(PREFIX).ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if bytes.len() < 45
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
            || !bytes.ends_with(b"\0\0\0\0IEND\xae\x42\x60\x82")
            || bytes[24] != 8
            || ![2, 6].contains(&bytes[25])
        {
            return Err(invalid());
        }
        let dimension = |i: usize| u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap());
        if ![dimension(16), dimension(20)]
            .into_iter()
            .all(|n| (1..=960).contains(&n))
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub(super) fn openai_input(&self, packet: &Value) -> Value {
        json!([{ "role":"user", "content":[{"type":"input_text","text":packet.to_string()},{"type":"input_image","image_url":self.png}] }])
    }
    pub(super) fn anthropic_content(&self, packet: &Value) -> Value {
        json!([{"type":"text","text":packet.to_string()},{"type":"image","source":{"type":"base64","media_type":"image/png","data":&self.png[PREFIX.len()..]}}])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reviews_use_bounded_inline_png_on_both_providers_and_bind_the_original_drawing_to_the_source(
    ) {
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
        let drawing = json!({"kind":"illustration", "view":"square", "passage":"A clock", "parts":[
            {"id":"clock","name":"Clock","about":"The clock","quote":"clock","selectable":true,"tone":"neutral",
            "shapes":[{"type":"circle","cx":15,"cy":15,"r":12,"paint":"outline"}]}
        ]});
        let mut review = Input {
            drawing,
            png: format!("{PREFIX}{encoded}"),
        };
        assert!(review.validate("A clock ticks.").is_ok());
        assert!(review.validate("A tree.").is_err());
        assert_eq!(
            review.openai_input(&json!({}))[0]["content"][1]["image_url"],
            review.png
        );
        assert_eq!(
            review.anthropic_content(&json!({}))[1]["source"]["data"],
            encoded
        );
        review.png = "https://external.example/image.png".into();
        assert!(review.validate("A clock").is_err());
        let mut bytes = STANDARD.decode(encoded).unwrap();
        bytes[16..20].copy_from_slice(&1024u32.to_be_bytes());
        review.png = format!("{PREFIX}{}", STANDARD.encode(bytes));
        assert!(review.validate("A clock").is_err());
    }
}
