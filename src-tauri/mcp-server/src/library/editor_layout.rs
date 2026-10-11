//! Structured layout edits use the renderer's existing portable Markdown fields.
//! No Markdown reserialization, arbitrary CSS, asset import, or new write path.
use super::editor::{exact_index, image_referenced, invalid, percent_encode};
use super::*;

const JUSTIFY: &str = "<!-- orion-text:v1 justify -->";
const IMAGE_PREFIX: &str = "orion-image-layout:v1:";

pub(super) fn image_schema() -> Value {
    object(
        json!({
            "placement":{"type":"string","enum":["inline","break","wrap"]},
            "alignment":{"type":"string","enum":["left","center","right"]},
            "widthPercent":{"type":"integer","minimum":15,"maximum":100},
            "xPercent":{"anyOf":[{"type":"number","minimum":0,"maximum":85},{"type":"null"}],"description":"At most two decimal places and no more than 100-widthPercent. Explicit null resets free placement and offsetY."},
            "offsetY":{"type":"integer","minimum":0,"maximum":10000},
            "gap":{"type":"integer","minimum":8,"maximum":40},
            "caption":{"type":"string","maxLength":500},
            "showCaption":{"type":"boolean"}
        }),
        &[],
    )
}

fn margin_marker(value: &str, kind: &str) -> Option<(u64, u64)> {
    let inside = value
        .strip_prefix(&format!("<!-- orion-{kind}-margins:v1 "))?
        .strip_suffix(" -->")?;
    let (left, right) = inside.split_once(' ')?;
    let integer = |value: &str| -> Option<u64> {
        let number = value.parse::<u64>().ok()?;
        (number <= 25 && number.to_string() == value).then_some(number)
    };
    Some((integer(left)?, integer(right)?))
}

fn patched_margin(args: &Map<String, Value>, key: &str, previous: u64) -> Result<u64, ToolFailure> {
    match args.get(key) {
        None => Ok(previous),
        Some(value) => value
            .as_u64()
            .filter(|number| *number <= 25)
            .ok_or_else(|| invalid("Margins must be integer percentages from 0 to 25.")),
    }
}

fn newline(body: &str) -> &str {
    if body.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn document_margins(body: &str, args: &Map<String, Value>) -> Result<String, ToolFailure> {
    let lines = text::lines(body);
    let mut prefix = 0;
    if lines
        .first()
        .is_some_and(|line| line.text.trim_end_matches([' ', '\t']) == "---")
    {
        let closing = lines
            .iter()
            .skip(1)
            .find(|line| line.text.trim_end_matches([' ', '\t']) == "---")
            .ok_or_else(|| {
                invalid("Close the document's --- frontmatter before changing margins.")
            })?;
        prefix = closing.byte + closing.text.len();
        if body[prefix..].starts_with("\r\n") {
            prefix += 2;
        } else if body[prefix..].starts_with('\n') {
            prefix += 1;
        } else {
            return Err(invalid(
                "Frontmatter needs a closing line break before document margins.",
            ));
        }
        while body[prefix..].starts_with("\r\n") || body[prefix..].starts_with('\n') {
            prefix += if body[prefix..].starts_with("\r\n") {
                2
            } else {
                1
            };
        }
    }
    let content = &body[prefix..];
    let line = content
        .split('\n')
        .next()
        .unwrap_or("")
        .trim_end_matches('\r');
    let existing = margin_marker(line, "document");
    if existing.is_none() && line.starts_with("<!-- orion-document-margins:") {
        return Err(invalid("The document has unknown or malformed margin metadata. Preserve it with an exact text edit before setting current margins."));
    }
    let (left, right) = existing.unwrap_or((0, 0));
    let updated = (
        patched_margin(args, "margin_left", left)?,
        patched_margin(args, "margin_right", right)?,
    );
    if updated == (left, right) {
        return Ok(body.into());
    }
    if existing.is_some() {
        if updated != (0, 0) {
            return Ok(format!(
                "{}<!-- orion-document-margins:v1 {} {} -->{}",
                &body[..prefix],
                updated.0,
                updated.1,
                &content[line.len()..]
            ));
        }
        let mut remove = line.len();
        for _ in 0..2 {
            if content[remove..].starts_with("\r\n") {
                remove += 2;
            } else if content[remove..].starts_with('\n') {
                remove += 1;
            }
        }
        return Ok(format!("{}{}", &body[..prefix], &content[remove..]));
    }
    Ok(format!(
        "{}<!-- orion-document-margins:v1 {} {} -->{}{}",
        &body[..prefix],
        updated.0,
        updated.1,
        if content.is_empty() {
            String::new()
        } else {
            newline(body).repeat(2)
        },
        content
    ))
}

fn unquote(mut line: &str) -> &str {
    loop {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            return line;
        }
        if let Some(rest) = trimmed.strip_prefix('>') {
            line = rest.strip_prefix(' ').unwrap_or(rest);
        } else {
            return line;
        }
    }
}

fn container_text(mut line: &str) -> &str {
    // Only used to reject fenced/HTML examples, never to rewrite their content.
    loop {
        let text = unquote(line).trim_start_matches([' ', '\t']);
        let digits = text.bytes().take_while(u8::is_ascii_digit).count();
        let prefix = if text.starts_with(['-', '+', '*']) && text[1..].starts_with([' ', '\t']) {
            1
        } else if (1..=9).contains(&digits)
            && text[digits..].starts_with(['.', ')'])
            && text[digits + 1..].starts_with([' ', '\t'])
        {
            digits + 1
        } else {
            return text;
        };
        line = &text[prefix..];
    }
}

fn reference_definition(text: &str) -> bool {
    text.starts_with('[') && text.contains("]:")
}

/// Add container-fence and HTML protections to the library's frontmatter/code map.
pub(super) fn safe_lines(body: &str) -> Vec<bool> {
    let mut fence: Option<(u8, usize)> = None;
    let mut comment = false;
    let mut html = false;
    let mut raw_html: Option<&str> = None;
    let mut reference = false;
    text::lines(body)
        .iter()
        .map(|line| {
            let text = container_text(line.text);
            let mut safe = line.visible && !comment && !html && raw_html.is_none();
            if reference_definition(text) {
                reference = true;
            }
            if reference {
                safe = false;
                if text.is_empty() {
                    reference = false;
                }
            }
            let lower = text.to_ascii_lowercase();
            if let Some(tag) = raw_html {
                if lower.contains(&format!("</{tag}>")) {
                    raw_html = None;
                }
            } else if let Some(tag) =
                ["script", "style", "pre", "textarea"]
                    .into_iter()
                    .find(|tag| {
                        lower
                            .strip_prefix(&format!("<{tag}"))
                            .is_some_and(|rest| rest.starts_with(['>', ' ', '\t']))
                    })
            {
                safe = false;
                if !lower.contains(&format!("</{tag}>")) {
                    raw_html = Some(tag);
                }
            }
            if html && text.is_empty() && raw_html.is_none() {
                html = false;
            }
            if text.starts_with('<')
                && !text.starts_with("<!--")
                && !text.starts_with("<http://")
                && !text.starts_with("<https://")
            {
                html = true;
                safe = false;
            }
            let marker = text.as_bytes().first().copied().unwrap_or(b' ');
            let width = text.bytes().take_while(|byte| *byte == marker).count();
            if let Some((open, count)) = fence {
                safe = false;
                if marker == open && width >= count && text[width..].trim().is_empty() {
                    fence = None;
                }
            } else if matches!(marker, b'`' | b'~')
                && width >= 3
                && (marker != b'`' || !text[width..].contains('`'))
            {
                fence = Some((marker, width));
                safe = false;
            }
            let mut remaining = line.text;
            loop {
                let marker = if comment { "-->" } else { "<!--" };
                let Some(index) = remaining.find(marker) else {
                    break;
                };
                remaining = &remaining[index + marker.len()..];
                comment = !comment;
            }
            safe && !comment
        })
        .collect()
}

#[derive(PartialEq, Eq)]
enum Kind {
    Prose,
    Heading,
    Item,
    Quote,
    Boundary,
    Unsupported,
}

fn kind(line: &str) -> Kind {
    let trimmed = line.trim_start_matches(' ');
    if trimmed.is_empty()
        || matches!(
            trimmed,
            "<!-- orion-block:v1 -->" | "<!-- /orion-block -->" | ">"
        )
    {
        return Kind::Boundary;
    }
    if line.len() - trimmed.len() > 3
        || trimmed.starts_with('\t')
        || trimmed.starts_with('<')
        || trimmed.starts_with("![")
        || reference_definition(trimmed)
        || trimmed.contains('|')
    {
        return Kind::Unsupported;
    }
    if trimmed.starts_with('>') {
        return if kind(unquote(trimmed)) == Kind::Prose {
            Kind::Quote
        } else {
            Kind::Unsupported
        };
    }
    let hashes = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with([' ', '\t']) {
        return Kind::Heading;
    }
    if trimmed.starts_with("```")
        || trimmed.starts_with("~~~")
        || trimmed
            .chars()
            .filter(|c| !c.is_whitespace())
            .all(|c| c == '-' || c == '*' || c == '_' || c == '=')
    {
        return Kind::Unsupported;
    }
    let bullet = trimmed
        .as_bytes()
        .first()
        .is_some_and(|byte| b"-+*".contains(byte))
        && trimmed[1..].starts_with([' ', '\t']);
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    let numbered = digits > 0
        && digits <= 9
        && trimmed[digits..].starts_with(['.', ')'])
        && trimmed[digits + 1..].starts_with([' ', '\t']);
    if bullet || numbered {
        let content =
            trimmed[if bullet { 1 } else { digits + 1 }..].trim_start_matches([' ', '\t']);
        if content.is_empty()
            || content.starts_with(['<', '>'])
            || content.starts_with("```")
            || content.starts_with("~~~")
            || content.starts_with("![")
            || content.contains('|')
            || ["- ", "+ ", "* "]
                .iter()
                .any(|prefix| content.starts_with(prefix))
        {
            Kind::Unsupported
        } else {
            Kind::Item
        }
    } else {
        Kind::Prose
    }
}

fn whole_anchor<'a>(
    body: &'a str,
    anchor: &str,
    image: bool,
) -> Result<(usize, usize), ToolFailure> {
    let start = exact_index(body, anchor)?;
    let end = start + anchor.len();
    let lines = text::lines(body);
    let first = lines
        .iter()
        .position(|line| line.byte == start)
        .ok_or_else(|| {
            invalid(
                "Select the entire Markdown paragraph, heading or image, not an inline fragment.",
            )
        })?;
    let last = lines.iter().position(|line| line.byte + line.text.len() == end).ok_or_else(|| invalid("The anchor must end at the complete content line, including existing formatting metadata."))?;
    if last < first || safe_lines(body)[first..=last].iter().any(|safe| !safe) {
        return Err(invalid(
            "Select complete visible content outside frontmatter, code fences and HTML examples.",
        ));
    }
    if image {
        if first != last
            || (first > 0 && kind(lines[first - 1].text) != Kind::Boundary)
            || (last + 1 < lines.len() && kind(lines[last + 1].text) != Kind::Boundary)
        {
            return Err(invalid(
                "Select a standalone managed image, separated from surrounding prose.",
            ));
        }
        return Ok((start, end));
    }
    let first_kind = kind(lines[first].text);
    if matches!(first_kind, Kind::Boundary | Kind::Unsupported)
        || (matches!(first_kind, Kind::Heading | Kind::Item) && first != last)
        || lines[first..=last]
            .iter()
            .any(|line| kind(line.text) != first_kind)
    {
        return Err(invalid("Select one complete ordinary paragraph or ATX heading. Lists require one complete item line; quoted prose requires its complete paragraph. Tables, code and structural ranges need their own commands."));
    }
    let adjacent = |index: usize| {
        let other = kind(lines[index].text);
        match first_kind {
            Kind::Prose => matches!(other, Kind::Prose | Kind::Quote),
            Kind::Quote => matches!(other, Kind::Prose | Kind::Quote),
            Kind::Item => matches!(other, Kind::Prose | Kind::Quote),
            _ => false,
        }
    };
    if (first > 0 && adjacent(first - 1))
        || (last + 1 < lines.len() && adjacent(last + 1))
        || (first_kind == Kind::Prose
            && last + 1 < lines.len()
            && lines[last + 1]
                .text
                .trim()
                .chars()
                .all(|c| c == '=' || c == '-')
            && !lines[last + 1].text.trim().is_empty())
    {
        return Err(invalid("The anchor cuts through a paragraph or structural continuation. Select the complete paragraph."));
    }
    Ok((start, end))
}

fn paragraph(body: &str, args: &Map<String, Value>) -> Result<String, ToolFailure> {
    let anchor = arg(args, "anchor");
    let (from, to) = whole_anchor(body, anchor, false)?;
    let mut prose = anchor;
    // Keep optional CommonMark closing hashes after the formatting suffix.
    let mut closing_hashes = "";
    if kind(anchor) == Kind::Heading {
        let trimmed = anchor.trim_end_matches([' ', '\t']);
        let hash_start = trimmed.trim_end_matches('#').len();
        if hash_start < trimmed.len()
            && hash_start > 0
            && trimmed[..hash_start].ends_with([' ', '\t'])
        {
            let start = trimmed[..hash_start].trim_end_matches([' ', '\t']).len();
            closing_hashes = &anchor[start..];
            prose = &anchor[..start];
        }
    }
    let mut margins = None;
    let mut justified = false;
    while prose.ends_with(" -->") {
        let Some(start) = prose.rfind("<!--") else {
            break;
        };
        let marker = &prose[start..];
        let parsed = margin_marker(marker, "paragraph");
        if marker != JUSTIFY && parsed.is_none() {
            break;
        }
        if margins.is_none() {
            margins = parsed;
        }
        justified |= marker == JUSTIFY;
        prose = prose[..start].strip_suffix(' ').unwrap_or(&prose[..start]);
    }
    let (left, right) = margins.unwrap_or((0, 0));
    let updated = (
        patched_margin(args, "margin_left", left)?,
        patched_margin(args, "margin_right", right)?,
    );
    let alignment = args.get("alignment").and_then(Value::as_str);
    let justify = alignment.map_or(justified, |value| value == "justify");
    if updated == (left, right) && justify == justified {
        return Ok(body.into());
    }
    let mut replacement = prose.to_owned();
    if justify {
        replacement.push(' ');
        replacement.push_str(JUSTIFY);
    }
    if updated != (0, 0) {
        replacement.push_str(&format!(
            " <!-- orion-paragraph-margins:v1 {} {} -->",
            updated.0, updated.1
        ));
    }
    Ok(format!(
        "{}{replacement}{closing_hashes}{}",
        &body[..from],
        &body[to..]
    ))
}

fn decode_percent(text: &str) -> Result<String, ToolFailure> {
    let mut output = Vec::new();
    let mut index = 0;
    let bytes = text.as_bytes();
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let end = index + 3;
            let digits = text
                .get(index + 1..end)
                .ok_or_else(|| invalid("Malformed image metadata."))?;
            output.push(
                u8::from_str_radix(digits, 16).map_err(|_| invalid("Malformed image metadata."))?,
            );
            index = end;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| invalid("Image metadata must contain valid UTF-8."))
}

fn image_parts(anchor: &str) -> Result<(&str, &str, Option<String>), ToolFailure> {
    let failure = || {
        invalid("Select the complete standalone Markdown managed image, including its existing double-quoted title metadata.")
    };
    if !anchor.starts_with("![") {
        return Err(failure());
    }
    let bytes = anchor.as_bytes();
    let mut index = 2;
    let mut depth = 1;
    while index < bytes.len() && depth > 0 {
        match bytes[index] {
            b'\\' => {
                index += 1;
                if index >= bytes.len() {
                    return Err(failure());
                }
            }
            b'[' => depth += 1,
            b']' => depth -= 1,
            _ => {}
        }
        index += 1;
    }
    if !anchor[index..].starts_with('(') {
        return Err(failure());
    }
    index += 1;
    let url_start = index;
    while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b')' {
        index += 1;
    }
    let url = &anchor[url_start..index];
    let prefix = &anchor[..index];
    if &anchor[index..] == ")" {
        return Ok((prefix, url, None));
    }
    while index < bytes.len() && bytes[index] == b' ' {
        index += 1;
    }
    if bytes.get(index) != Some(&b'"') {
        return Err(failure());
    }
    index += 1;
    let mut title = String::new();
    let mut chars = anchor[index..].char_indices();
    while let Some((offset, character)) = chars.next() {
        if character == '"' {
            if &anchor[index + offset + 1..] != ")" {
                return Err(failure());
            }
            return Ok((prefix, url, Some(title)));
        }
        if character == '\\' {
            let (_, escaped) = chars.next().ok_or_else(failure)?;
            if !escaped.is_ascii_punctuation() {
                title.push('\\');
            }
            title.push(escaped);
        } else {
            title.push(character);
        }
    }
    Err(failure())
}

fn image_layout(body: &str, args: &Map<String, Value>) -> Result<String, ToolFailure> {
    let anchor = arg(args, "anchor");
    let (from, to) = whole_anchor(body, anchor, true)?;
    let (prefix, url, title) = image_parts(anchor)?;
    let asset = url.strip_prefix("orion-image://localhost/").unwrap_or("");
    if !(12..=80).contains(&asset.len())
        || !asset
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        || !image_referenced(body, url)
    {
        return Err(invalid("Layout changes require an existing managed image in this exact note. No file or network import is performed."));
    }
    let defaults = json!({"placement":"inline","alignment":"center","widthPercent":100,"xPercent":null,"offsetY":0,"gap":18,"caption":"","showCaption":false});
    let mut metadata = if let Some(text) = title
        .as_deref()
        .and_then(|title| title.strip_prefix(IMAGE_PREFIX))
    {
        if title.as_ref().unwrap().len() > 8_192 {
            return Err(invalid("Image metadata exceeds its portable limit."));
        }
        serde_json::from_str::<Value>(&decode_percent(text)?)
            .map_err(|_| invalid("Malformed image layout metadata."))?
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("Image layout metadata must be an object."))?
    } else {
        // The canonical editor writes literal titles. Other Markdown authors can
        // encode HTML entities here, which would need a complete Markdown parser
        // before moving them into JSON; fail closed instead of changing meaning.
        if title.as_deref().is_some_and(|title| {
            title.split('&').skip(1).any(|tail| {
                tail.split_once(';').is_some_and(|(entity, _)| {
                    !entity.is_empty()
                        && entity
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'#')
                })
            })
        }) {
            return Err(invalid("This image has an entity-encoded title. Reopen and save it in the editor before changing its structured layout."));
        }
        let mut value = Map::new();
        value.insert("title".into(), json!(title.unwrap_or_default()));
        value
    };
    if !metadata.contains_key("showCaption")
        && metadata
            .get("caption")
            .and_then(Value::as_str)
            .is_some_and(|caption| !caption.is_empty())
    {
        metadata.insert("showCaption".into(), json!(true));
    }
    for (key, value) in defaults.as_object().unwrap() {
        metadata.entry(key).or_insert_with(|| value.clone());
    }
    metadata.entry("title").or_insert_with(|| json!(""));
    let changes = args
        .get("layout")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Provide a nonempty partial layout object."))?;
    if changes.is_empty() {
        return Err(invalid("Provide at least one image layout field."));
    }
    metadata.extend(changes.clone());
    if changes.get("xPercent").is_some_and(Value::is_null) && !changes.contains_key("offsetY") {
        metadata.insert("offsetY".into(), json!(0));
    }
    let known: Map<_, _> = defaults
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (key.clone(), metadata[key].clone()))
        .collect();
    validate_value(&Value::Object(known), &image_schema(), "layout")?;
    let width = metadata["widthPercent"].as_f64().unwrap();
    if let Some(x) = metadata["xPercent"].as_f64() {
        if x > 100.0 - width || (x * 100.0 - (x * 100.0).round()).abs() > 0.000001 {
            return Err(invalid(
                "xPercent must fit the image width and use at most two decimal places.",
            ));
        }
    } else if metadata["offsetY"] != 0 {
        return Err(invalid(
            "offsetY requires numeric xPercent; use zero when free placement is off.",
        ));
    }
    for key in ["caption", "title"] {
        if !metadata[key].as_str().is_some_and(|value| {
            value.encode_utf16().count() <= 500
                && !value
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        }) {
            return Err(invalid("Image caption and title must be bounded literal strings, at most 500 UTF-16 characters."));
        }
    }
    let ordinary = defaults
        .as_object()
        .unwrap()
        .iter()
        .all(|(key, value)| metadata.get(key) == Some(value))
        && metadata.len() == defaults.as_object().unwrap().len() + 1;
    let ordinary_title = metadata["title"].as_str().unwrap().to_owned();
    let encoded = format!(
        "{IMAGE_PREFIX}{}",
        percent_encode(&Value::Object(metadata).to_string())
    );
    if encoded.len() > 8_192 {
        return Err(invalid(
            "Updated image metadata exceeds its portable 8,192-character title limit.",
        ));
    }
    let title = if ordinary {
        ordinary_title
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace(['\n', '\r'], " ")
    } else {
        encoded
    };
    Ok(format!(
        "{}{}{}){}",
        &body[..from],
        prefix,
        if title.is_empty() {
            String::new()
        } else {
            format!(" \"{title}\"")
        },
        &body[to..]
    ))
}

pub(super) fn apply(current: &Note, args: &Map<String, Value>) -> Result<String, ToolFailure> {
    let command = arg(args, "command");
    let specific: &[&str] = match command {
        "paragraph_format" => &["anchor", "alignment", "margin_left", "margin_right"],
        "document_margins" => &["margin_left", "margin_right"],
        "image_layout" => &["anchor", "layout"],
        _ => unreachable!(),
    };
    if args.keys().any(|key| {
        !["space_id", "note_id", "expected_version", "command"].contains(&key.as_str())
            && !specific.contains(&key.as_str())
    }) {
        return Err(invalid("Layout commands modify existing content and accept only their documented layout fields, not insertion placement or replacement text."));
    }
    if command != "image_layout"
        && !["alignment", "margin_left", "margin_right"]
            .iter()
            .any(|key| args.contains_key(*key))
    {
        return Err(invalid(
            "Provide at least one alignment or margin value; omitted values are preserved.",
        ));
    }
    match command {
        "paragraph_format" => paragraph(&current.body, args),
        "document_margins" => document_margins(&current.body, args),
        "image_layout" => image_layout(&current.body, args),
        _ => unreachable!(),
    }
}
