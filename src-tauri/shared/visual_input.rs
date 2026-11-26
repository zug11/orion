//! Schema checks shared by the native image review and MCP artifact insertion.
use serde_json::Value;

#[path = "visual_illustration.rs"]
pub(crate) mod illustration;

pub(crate) fn invalid(message: &str) -> String {
    format!("Invalid visual artifact: {message}")
}

pub(crate) fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("expected an object"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        let name: String = key.chars().take(80).collect();
        return Err(invalid(&format!("unexpected field {name:?}")));
    }
    Ok(())
}

pub(crate) fn list(value: &Value, min: usize, max: usize) -> Result<&[Value], String> {
    value
        .as_array()
        .map(Vec::as_slice)
        .filter(|list| (min..=max).contains(&list.len()))
        .ok_or_else(|| invalid(&format!("expected a list with {min} to {max} entries")))
}

// ECMAScript whitespace (String.trim and the SVG path tokenizer).
pub(crate) fn js_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

pub(crate) fn literal(value: &Value, max: usize, allow_empty: bool) -> Result<&str, String> {
    let text = value.as_str().ok_or_else(|| invalid("expected text"))?;
    if text.encode_utf16().take(max + 1).count() > max
        || (!allow_empty && text.trim_matches(js_space).is_empty())
        || text
            .bytes()
            .any(|b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r') || b == 0x7f)
    {
        return Err(invalid(&format!(
            "expected valid text within {max} UTF-16 units"
        )));
    }
    Ok(text)
}

pub(crate) fn number(value: &Value, min: f64, max: f64) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(|| invalid(&format!("expected a number from {min} to {max}")))
}
