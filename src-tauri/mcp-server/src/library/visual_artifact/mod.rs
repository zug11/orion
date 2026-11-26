//! Native v1 note artifacts. Keep this contract in sync with
//! src/lib/visualArtifacts.ts and visualArtifactCalculatorRanges.ts.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, io};

mod calculator;

const MAX_ARTIFACT_BYTES: usize = 48_000;
const PAINTS: [&str; 7] = ["none", "ink", "muted", "accent", "warm", "cool", "surface"];

fn invalid(message: &str) -> String {
    format!("Invalid visual artifact: {message}")
}

fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("expected an object"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        let name: String = key.chars().take(80).collect();
        return Err(invalid(&format!("unexpected field {name:?}")));
    }
    Ok(())
}

fn list(value: &Value, min: usize, max: usize) -> Result<&[Value], String> {
    value
        .as_array()
        .map(Vec::as_slice)
        .filter(|list| (min..=max).contains(&list.len()))
        .ok_or_else(|| invalid(&format!("expected a list with {min} to {max} entries")))
}

// ECMAScript whitespace (String.trim and the SVG path tokenizer).
fn js_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

fn literal(value: &Value, max: usize, allow_empty: bool) -> Result<&str, String> {
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

fn number(value: &Value, min: f64, max: f64) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(|| invalid(&format!("expected a number from {min} to {max}")))
}

fn index(value: &Value, count: usize) -> Result<usize, String> {
    let n = number(value, 0.0, count as f64 - 1.0)?;
    if n.fract() != 0.0 {
        return Err(invalid("expected a whole-number index"));
    }
    Ok(n as usize)
}

fn text_field(value: &Value, key: &str, max: usize) -> Result<(), String> {
    literal(&value[key], max, false)
        .map(|_| ())
        .map_err(|e| format!("{key}: {e}"))
}

fn optional_text(value: &Value, key: &str, max: usize) -> Result<(), String> {
    if value.get(key).is_some() {
        text_field(value, key, max)?;
    }
    Ok(())
}

// SVG absolute commands only, including repeated parameter groups.
fn validate_path(value: &Value) -> Result<(), String> {
    let mut tail = literal(value, 1200, false)?.trim_matches(js_space);
    let mut arity = None;
    let mut needed = 0;
    let mut groups = 0;
    let mut previous_number = false;
    let error = || invalid("expected a complete M/L/H/V/Q/C/Z path inside the 100 × 100 drawing");
    while !tail.is_empty() {
        tail = tail.trim_start_matches(js_space);
        let Some(&ch) = tail.as_bytes().first() else {
            break;
        };
        if ch == b',' {
            tail = tail[1..].trim_start_matches(js_space);
            if !previous_number || !tail.starts_with(|ch: char| ch.is_ascii_digit() || ch == '.') {
                return Err(error());
            }
            previous_number = false;
            continue;
        }
        let command = match ch {
            b'M' | b'L' => Some(2),
            b'H' | b'V' => Some(1),
            b'Q' => Some(4),
            b'C' => Some(6),
            b'Z' => Some(0),
            _ => None,
        };
        if let Some(size) = command {
            if needed != 0 || (arity.is_none() && ch != b'M') {
                return Err(error());
            }
            arity = Some(size);
            needed = size;
            previous_number = false;
            groups += 1;
            tail = &tail[1..];
        } else {
            let size = arity.filter(|&n| n != 0).ok_or_else(error)?;
            let bytes = tail.as_bytes();
            let whole = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
            let mut end = whole;
            if bytes.get(end) == Some(&b'.') {
                end += 1;
                let decimals = bytes[end..]
                    .iter()
                    .take_while(|b| b.is_ascii_digit())
                    .count();
                if whole == 0 && decimals == 0 {
                    return Err(error());
                }
                end += decimals;
            }
            if end == 0 {
                return Err(error());
            }
            let coordinate = tail[..end].parse::<f64>().map_err(|_| error())?;
            if !(0.0..=100.0).contains(&coordinate) {
                return Err(error());
            }
            if needed == 0 {
                groups += 1;
                needed = size;
            }
            needed -= 1;
            tail = &tail[end..];
            previous_number = true;
        }
        if groups > 64 {
            return Err(invalid("a drawing path may have at most 64 command groups"));
        }
    }
    if arity.is_none() || needed != 0 {
        return Err(error());
    }
    Ok(())
}

fn shape(value: &Value) -> Result<(), String> {
    for key in ["fill", "stroke"] {
        if !value[key].as_str().is_some_and(|v| PAINTS.contains(&v)) {
            return Err(invalid(&format!("invalid {key} paint")));
        }
    }
    if value["fill"] == "none" && value["stroke"] == "none" {
        return Err(invalid("a shape needs a visible fill or stroke"));
    }
    let coord = |key: &str| number(&value[key], 0.0, 100.0);
    match value["kind"].as_str() {
        Some("path") => {
            fields(value, &["kind", "fill", "stroke", "d"])?;
            validate_path(&value["d"])?;
        }
        Some("rect") => {
            fields(
                value,
                &[
                    "kind", "fill", "stroke", "x", "y", "width", "height", "level",
                ],
            )?;
            let (x, y, w, h) = (coord("x")?, coord("y")?, coord("width")?, coord("height")?);
            if w == 0.0
                || h == 0.0
                || x + w > 100.0
                || y + h > 100.0
                || value.get("level").is_some_and(|v| !v.is_boolean())
            {
                return Err(invalid("invalid rectangle geometry or level flag"));
            }
        }
        Some("circle") => {
            fields(value, &["kind", "fill", "stroke", "cx", "cy", "r"])?;
            let (x, y, r) = (coord("cx")?, coord("cy")?, coord("r")?);
            if r == 0.0 || r > x.min(y).min(100.0 - x).min(100.0 - y) {
                return Err(invalid(
                    "circle extends outside its drawing or has zero radius",
                ));
            }
        }
        _ => return Err(invalid("unknown shape kind")),
    }
    Ok(())
}

fn scene(value: &Value) -> Result<(), String> {
    fields(value, &["kind", "nodes", "frames"])?;
    let nodes = list(&value["nodes"], 1, 8)?;
    for node in nodes {
        fields(node, &["label", "alt", "x", "y", "shapes"])?;
        text_field(node, "label", 80)?;
        text_field(node, "alt", 300)?;
        number(&node["x"], 0.0, 100.0)?;
        number(&node["y"], 0.0, 100.0)?;
        for item in list(&node["shapes"], 1, 24)? {
            shape(item)?;
        }
    }
    let n = nodes.len();
    for frame in list(&value["frames"], 1, 12)? {
        fields(frame, &["label", "caption", "values", "levels", "flows"])?;
        text_field(frame, "label", 80)?;
        text_field(frame, "caption", 1000)?;
        for v in list(&frame["values"], n, n)? {
            literal(v, 100, true)?;
        }
        for v in list(&frame["levels"], n, n)? {
            if !v.is_null() {
                number(v, 0.0, 1.0)?;
            }
        }
        for flow in list(&frame["flows"], 0, 16)? {
            fields(flow, &["from", "to", "label"])?;
            if index(&flow["from"], n)? == index(&flow["to"], n)? {
                return Err(invalid("a flow needs two different nodes"));
            }
            literal(&flow["label"], 80, true)?;
        }
    }
    Ok(())
}

fn block(value: &Value) -> Result<(), String> {
    match value["kind"].as_str() {
        Some("text") => {
            fields(value, &["kind", "heading", "text"])?;
            optional_text(value, "heading", 160)?;
            text_field(value, "text", 2000)?;
        }
        Some("steps") => {
            fields(value, &["kind", "items"])?;
            for item in list(&value["items"], 1, 24)? {
                fields(item, &["label", "heading", "text"])?;
                text_field(item, "label", 80)?;
                text_field(item, "heading", 180)?;
                text_field(item, "text", 1200)?;
            }
        }
        Some("table") => {
            fields(value, &["kind", "columns", "rows"])?;
            let columns = list(&value["columns"], 2, 6)?;
            let blank_corner = columns[0] == "";
            for (i, col) in columns.iter().enumerate() {
                literal(col, 100, i == 0 && blank_corner)?;
            }
            for row in list(&value["rows"], 1, 24)? {
                for (i, cell) in list(row, columns.len(), columns.len())?.iter().enumerate() {
                    literal(cell, 400, i != 0 || !blank_corner)?;
                }
            }
        }
        Some("quiz") => {
            fields(value, &["kind", "items"])?;
            for item in list(&value["items"], 1, 20)? {
                fields(item, &["question", "choices", "answer", "explanation"])?;
                text_field(item, "question", 500)?;
                text_field(item, "explanation", 800)?;
                let choices = list(&item["choices"], 2, 6)?;
                let mut distinct = HashSet::new();
                for choice in choices {
                    if !distinct.insert(literal(choice, 350, false)?.trim_matches(js_space)) {
                        return Err(invalid("quiz choices must be distinct"));
                    }
                }
                index(&item["answer"], choices.len())?;
            }
        }
        Some("cards") => {
            fields(value, &["kind", "items"])?;
            for item in list(&value["items"], 1, 32)? {
                fields(item, &["front", "back"])?;
                text_field(item, "front", 500)?;
                text_field(item, "back", 1200)?;
            }
        }
        Some("scene") => scene(value)?,
        Some("calculator") => calculator::validate(value)?,
        _ => return Err(invalid("unknown block kind")),
    }
    Ok(())
}

// JSON.stringify uses ECMAScript's shortest representation even for 1.0 and
// small exponents. Match the renderer's UTF-8 byte budget at the boundary.
struct MarkerFormatter;
impl serde_json::ser::Formatter for MarkerFormatter {
    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(ryu_js::Buffer::new().format_finite(value).as_bytes())
    }
}

pub(super) fn validated_marker(value: &Value) -> Result<String, String> {
    fields(value, &["version", "format", "title", "summary", "blocks"])?;
    if value["version"].as_f64() != Some(1.0) {
        return Err(invalid("expected version 1"));
    }
    let required = match value["format"].as_str() {
        Some("explainer") => None,
        Some("timeline") => Some("steps"),
        Some("quiz") => Some("quiz"),
        Some("comparison") => Some("table"),
        Some("flashcards") => Some("cards"),
        Some("calculator") => Some("calculator"),
        _ => return Err(invalid("unknown format")),
    };
    text_field(value, "title", 160)?;
    optional_text(value, "summary", 600)?;
    let blocks = list(&value["blocks"], 1, 12)?;
    for (i, item) in blocks.iter().enumerate() {
        block(item).map_err(|error| format!("artifact.blocks[{i}]: {error}"))?;
    }
    if let Some(kind) = required {
        if !blocks.iter().any(|b| b["kind"] == kind) {
            return Err(invalid(&format!("this format requires a {kind} block")));
        }
    }

    // The v1 reader trims path data while keeping authored labels and prose literal.
    let mut normalized = value.clone();
    for item in normalized["blocks"].as_array_mut().unwrap() {
        if item["kind"] == "scene" {
            for node in item["nodes"].as_array_mut().unwrap() {
                for shape in node["shapes"].as_array_mut().unwrap() {
                    if let Some(d) = shape.get_mut("d") {
                        *d = Value::String(d.as_str().unwrap().trim_matches(js_space).to_owned());
                    }
                }
            }
        }
    }
    let mut bytes = Vec::new();
    normalized
        .serialize(&mut serde_json::Serializer::with_formatter(
            &mut bytes,
            MarkerFormatter,
        ))
        .map_err(|e| format!("Could not serialize artifact: {e}"))?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(invalid("the v1 document exceeds 48,000 UTF-8 bytes"));
    }
    Ok(format!(
        "<!-- orion-artifact:v1 {} -->",
        STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_drawing_commands_and_implicit_groups() {
        for valid in [
            "M.5.4, 4,5Z",
            "M0 0 Q1 2 3 4 5 6 7 8 C0 1 2 3 4 5",
            "M1. 2. H0 100 V20Z",
        ] {
            validate_path(&json!(valid)).unwrap();
        }
        for invalid in [
            "Z",
            "M",
            "M1 2Z2",
            "M0 0 L1",
            "M0 Z",
            "M0 0L. 1",
            "M0,,1",
            "M0 0,",
            "M0,\n L2 2",
            "M1e2 1",
            "M-0 2",
            "M0 101",
            "M0 0 l2 2",
            "M0\u{85}0",
            "M0 0ZZ 1 2",
        ] {
            assert!(validate_path(&json!(invalid)).is_err(), "{invalid}");
        }
        let allowed = format!("M1 2{}", " 0 0".repeat(63));
        assert!(validate_path(&json!(allowed)).is_ok());
        assert!(validate_path(&json!(format!("{allowed}Z"))).is_err());
    }

    #[test]
    fn normalizes_geometry_and_uses_browser_numbers_without_changing_authored_text() {
        let scene = json!({"kind":"scene","nodes":[{"label":"  Orbit  ","alt":"Point","x":1.0,"y":0,
            "shapes":[{"kind":"path","d":" \nM1 2Z\u{feff}","fill":"ink","stroke":"none"}]}],
            "frames":[{"label":"First","caption":"Orbit","values":[""],"levels":[1e-6],"flows":[]}]});
        let marker = validated_marker(
            &json!({"version":1.0,"title":"  First  ","format":"explainer","blocks":[scene]}),
        )
        .unwrap();
        let (prefix, suffix) = ("<!-- orion-artifact:v1 ", " -->");
        let text = String::from_utf8(
            STANDARD
                .decode(
                    marker
                        .strip_prefix(prefix)
                        .unwrap()
                        .strip_suffix(suffix)
                        .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(text.contains(r#""version":1,"#) || text.contains(r#""version":1}"#));
        assert!(text.contains(r#""levels":[0.000001]"#));
        assert!(text.contains(r#""d":"M1 2Z""#));
        assert!(text.contains(r#""title":"  First  ""#));
        assert!(text.contains(r#""label":"  Orbit  ""#));
    }

    #[test]
    fn treats_string_lengths_whitespace_and_optional_fields_like_the_v1_reader() {
        let mut art = json!({"version":1,"format":"quiz","title":"🪐".repeat(80),"blocks":[{"kind":"quiz","items":[
            {"question":"Question","choices":["North","South"],"answer":1,"explanation":"South."}
        ]}]});
        assert!(validated_marker(&art).is_ok());
        art["title"] = json!("🪐".repeat(81));
        assert!(validated_marker(&art).is_err());
        art["title"] = json!("\u{feff}");
        assert!(validated_marker(&art).is_err());
        art["title"] = json!("\u{85}");
        assert!(validated_marker(&art).is_ok());
        art["blocks"][0]["items"][0]["choices"][1] = json!("\u{feff}North\u{a0}");
        assert!(validated_marker(&art).is_err());
        art["blocks"][0]["items"][0]["choices"][1] = json!("South");
        art["summary"] = Value::Null;
        assert!(validated_marker(&art).is_err());
    }

    #[test]
    fn enforces_canonical_utf8_size_at_the_exact_limit() {
        let mut rows = vec![vec!["界".repeat(170); 6]; 16];
        let mut art = json!({"version":1,"format":"comparison","title":"A","blocks":[{
            "kind":"table","columns":["A","B","C","D","E","F"],"rows":rows
        }]});
        assert!(validated_marker(&art).is_err());
        // Tune the existing bounded cells so the complete JSON is exactly 48,000 bytes.
        let mut excess = serde_json::to_vec(&art).unwrap().len() - MAX_ARTIFACT_BYTES;
        for cell in rows.iter_mut().flatten() {
            let remove = excess.min(500);
            *cell = format!(
                "{}{}",
                "界".repeat((510 - remove) / 3),
                "x".repeat((510 - remove) % 3)
            );
            excess -= remove;
            if excess == 0 {
                break;
            }
        }
        art["blocks"][0]["rows"] = json!(rows);
        assert_eq!(serde_json::to_vec(&art).unwrap().len(), MAX_ARTIFACT_BYTES);
        assert!(validated_marker(&art).is_ok());
        art["title"] = json!("AB");
        assert!(validated_marker(&art).is_err());
    }
}
