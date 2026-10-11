//! Local formatting commands produce only the editor's portable note content.
//! Every source/destination lookup happens inside write::call's vault lock.
use super::*;

const BLOCK_OPEN: &str = "<!-- orion-block:v1 -->";
const BLOCK_CLOSE: &str = "<!-- /orion-block -->";
const COMMANDS: &[&str] = &[
    "text",
    "block",
    "heading",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "todo",
    "bullet",
    "numbered",
    "divider",
    "quote",
    "code",
    "table",
    "link",
    "excerpt",
    "image",
    "paragraph_format",
    "document_margins",
    "image_layout",
    "table_layout",
    "table_edit",
    "inline_format",
    "unlink",
    "source_citation",
];

pub(super) fn input_fields() -> Value {
    json!({
        "note_id":string(200), "expected_version":string(100),
        "command":{"type":"string","enum":COMMANDS},
        "citation_action":{"type":"string","enum":["insert","remove"],"description":"source_citation only. Insert a numbered reference and attach its source atomically, or remove one marker while retaining source provenance."},
        "source_id":string(200),
        "source_expected_version":{"type":"string","minLength":1,"maxLength":100,"description":"Required for source_citation insert, from a current source read in this exact Space. Not accepted for removal."},
        "mark":{"type":"string","enum":["bold","italic","strike","code"],"description":"inline_format only: change one portable inline mark, preserving the selected words and all other marks."},
        "enabled":{"type":"boolean","description":"inline_format only: true applies the mark; false removes it. Never toggles. Removal requires complete marked spans."},
        "placement":choice(&["append","prepend","before","after","replace"],"append"),
        "anchor":{"type":"string","minLength":1,"maxLength":50000,"description":"Exact unique destination text; required only for before, after, or replace. Surrounding content is preserved."},
        "text":{"type":"string","maxLength":50000,"description":"Literal content, except block accepts Markdown. Required for text/heading/quote/code/excerpt; optional label for link. An omitted block text wraps anchor when replacing, otherwise creates an empty block."},
        "level":integer(2,1,6),
        "items":{"type":"array","minItems":1,"maxItems":100,"items":object(json!({"text":string(2000),"checked":{"type":"boolean"}}),&["text"]),"description":"Items for todo/bullet/numbered. checked is accepted only for todo; omitted means unchecked."},
        "language":{"type":"string","maxLength":40,"description":"Optional code language identifier: letters, digits, underscore, plus, or hyphen."},
        "rows":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"array","minItems":1,"maxItems":12,"items":{"type":"string","maxLength":2000}},"description":"Rectangular literal-text table, at most 20 rows and 12 columns. First row is the header unless header=false."},
        "header":{"type":"boolean","default":true},
        "target_note_id":string(200), "target_expected_version":string(100),
        "url":{"type":"string","minLength":1,"maxLength":2048,"description":"For link only: an HTTP/HTTPS web address or recognizable bare domain (normalized to HTTPS). Supply exactly one of url or target_note_id. No credentials, controls, backslashes, or network access. Omitted text preserves the replacement anchor, otherwise uses the normalized URL."},
        "image_url":{"type":"string","minLength":1,"maxLength":120,"description":"An existing orion-image://localhost/ASSET_ID referenced by an image in this same Space. No file or network import."},
        "alt":{"type":"string","maxLength":500},
        "alignment":{"type":"string","enum":["left","justify"],"description":"paragraph_format only; left removes the existing justify suffix."},
        "margin_left":{"type":"integer","minimum":0,"maximum":25,"description":"Paragraph or document left margin, as an integer percentage. Zero resets this side; omitted preserves it."},
        "margin_right":{"type":"integer","minimum":0,"maximum":25,"description":"Paragraph or document right margin, as an integer percentage. Zero resets this side; omitted preserves it."},
        "layout":editor_layout::image_schema(),
        "table_layout":editor_table::layout_schema(),
        "operation":{"type":"string","enum":["insert_row","delete_row","insert_column","delete_column","set_cell","resize","delete"]},
        "row_index":{"type":"integer","minimum":0,"maximum":50000,"description":"Zero-based logical row; includes a real header but never the synthetic header of a headerless table. Insertion inserts before this index; row count appends."},
        "column_index":{"type":"integer","minimum":0,"maximum":100,"description":"Zero-based column; insertion before this index, column count appends."},
        "values":{"type":"array","maxItems":50000,"items":{"type":"string","maxLength":2000},"description":"Literal cells for an inserted row/column; omitted means empty cells. Must match the opposite dimension."},
        "row_count":{"type":"integer","minimum":1,"maximum":50000},
        "column_count":{"type":"integer","minimum":1,"maximum":100},
        "allow_content_removal":{"type":"boolean","description":"Only for resize: explicitly permits removing nonempty cells at bottom/right edges."}
    })
}

pub(super) struct PreparedEdit {
    pub body: String,
    pub attach_source: Option<String>,
}

pub(super) fn prepare(
    scope: &Space,
    current: &Note,
    args: &Map<String, Value>,
) -> Result<PreparedEdit, ToolFailure> {
    if arg(args, "command") == "source_citation" {
        editor_citations::apply(scope, current, args)
    } else {
        Ok(PreparedEdit {
            body: apply(scope, current, args)?,
            attach_source: None,
        })
    }
}

pub(super) fn invalid(message: &str) -> ToolFailure {
    ToolFailure::new(format!("{message} Nothing was saved."))
}

pub(super) fn exact_index(body: &str, selected: &str) -> Result<usize, ToolFailure> {
    if selected.is_empty() {
        return Err(invalid("Supply a nonempty exact anchor."));
    }
    let first = body
        .find(selected)
        .ok_or_else(|| invalid("The exact selected text is absent."))?;
    let next = first + body[first..].chars().next().unwrap().len_utf8();
    if body[next..].contains(selected) {
        return Err(invalid(
            "The selected text is ambiguous. Supply a longer unique selection.",
        ));
    }
    Ok(first)
}

fn require_text<'a>(args: &'a Map<String, Value>) -> Result<&'a str, ToolFailure> {
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("This command requires text."))?;
    if text.trim().is_empty() {
        return Err(invalid("This command needs nonempty text."));
    }
    Ok(text)
}

pub(super) fn inline(text: &str) -> String {
    let mut output = String::new();
    for character in text.chars() {
        if matches!(
            character,
            '\\' | '`'
                | '*'
                | '_'
                | '~'
                | '['
                | ']'
                | '<'
                | '>'
                | '!'
                | '#'
                | '|'
                | '+'
                | '-'
                | '.'
                | '='
                | '&'
        ) {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

fn single_line(text: &str) -> Result<String, ToolFailure> {
    if text.contains(['\n', '\r']) {
        return Err(invalid(
            "This command requires single-line labels or items.",
        ));
    }
    literal_indentation(text)?;
    Ok(inline(text))
}

fn literal_indentation(text: &str) -> Result<(), ToolFailure> {
    if text.lines().any(|line| {
        line.starts_with("    ")
            || line
                .chars()
                .take_while(|c| matches!(c, ' ' | '\t'))
                .any(|c| c == '\t')
    }) {
        return Err(invalid("Literal text cannot start with code indentation. Use the code command or explicit Markdown in block."));
    }
    Ok(())
}

fn join_blocks(left: &str, right: &str) -> String {
    if left.is_empty() {
        return right.into();
    }
    if right.is_empty() {
        return left.into();
    }
    let existing = left.chars().rev().take_while(|c| *c == '\n').count()
        + right.chars().take_while(|c| *c == '\n').count();
    format!(
        "{left}{}{right}",
        "\n".repeat(2usize.saturating_sub(existing))
    )
}

fn block(text: &str) -> Result<String, ToolFailure> {
    let mut depth = 0usize;
    let mut fence: Option<(u8, usize)> = None;
    let mut content = String::new();
    for raw in text.split_inclusive('\n') {
        let line = raw.trim_end_matches(['\r', '\n']);
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let marker = trimmed.as_bytes().first().copied().unwrap_or(b' ');
        let count = trimmed.bytes().take_while(|byte| *byte == marker).count();
        if let Some((open, width)) = fence {
            if indent <= 3 && marker == open && count >= width && trimmed[count..].trim().is_empty()
            {
                fence = None;
            }
            content.push_str(raw);
        } else if indent <= 3
            && matches!(marker, b'`' | b'~')
            && count >= 3
            && (marker == b'~' || !trimmed[count..].contains('`'))
        {
            fence = Some((marker, count));
            content.push_str(raw);
        } else if line == BLOCK_OPEN {
            depth += 1;
            if !content.ends_with('\n') && !content.is_empty() {
                content.push('\n');
            }
            content.push('\n');
        } else if line == BLOCK_CLOSE {
            if depth == 0 {
                return Err(invalid(
                    "Block content contains an unmatched closing marker.",
                ));
            }
            depth -= 1;
            if !content.ends_with('\n') && !content.is_empty() {
                content.push('\n');
            }
            content.push('\n');
        } else {
            content.push_str(raw);
        }
    }
    if depth != 0 || fence.is_some() {
        return Err(invalid(
            "Close every block marker and fenced code example before wrapping it.",
        ));
    }
    Ok(format!(
        "{BLOCK_OPEN}\n{}\n{BLOCK_CLOSE}\n\n",
        content.trim_matches(['\r', '\n'])
    ))
}

fn target<'a>(scope: &'a Space, args: &Map<String, Value>) -> Result<&'a Note, ToolFailure> {
    let id = arg(args, "target_note_id");
    if id.is_empty()
        || id.chars().any(|c| {
            c.is_whitespace()
                || matches!(
                    c,
                    '"' | '<' | '>' | '(' | ')' | '[' | ']' | '\\' | '?' | '#'
                )
        })
    {
        return Err(invalid(
            "Provide an exact link-safe target_note_id in this Space.",
        ));
    }
    note(scope, id)
}

/// Match the renderer's recognizable-bare-domain gate before WHATWG parsing.
/// Explicit HTTP(S) addresses may also use localhost or an IP address.
fn bare_web_domain(text: &str) -> bool {
    let authority = text.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some((host, port)) = authority.rsplit_once(':') {
        if port.is_empty() || port.len() > 5 || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        host
    } else {
        authority
    };
    let labels: Vec<_> = host.split('.').collect();
    labels.len() > 1
        && labels.iter().enumerate().all(|(index, label)| {
            let mut chars = label.chars();
            let Some(first) = chars.next() else {
                return false;
            };
            (if index == labels.len() - 1 {
                first.is_alphabetic()
            } else {
                first.is_alphanumeric()
            }) && label.chars().last().is_some_and(char::is_alphanumeric)
                && chars.all(|character| character.is_alphanumeric() || character == '-')
        })
}

/// Keep URL policy aligned with src/lib/externalLinks.ts; this never fetches.
fn external_link(value: &str) -> Result<String, ToolFailure> {
    let text = value.trim();
    let failure = || {
        invalid("Provide a web URL of at most 2,048 characters using HTTP or HTTPS, without credentials, controls, spaces, or backslashes.")
    };
    if text.is_empty()
        || text.encode_utf16().count() > 2_048
        || text
            .chars()
            .any(|character| character <= '\u{20}' || character == '\u{7f}' || character == '\\')
    {
        return Err(failure());
    }
    let lower = text.to_ascii_lowercase();
    let candidate = if lower.starts_with("https://") || lower.starts_with("http://") {
        text.to_owned()
    } else if bare_web_domain(text) {
        format!("https://{text}")
    } else {
        return Err(failure());
    };
    let parsed = url::Url::parse(&candidate).map_err(|_| failure())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.as_str().encode_utf16().count() > 2_048
    {
        return Err(failure());
    }
    Ok(parsed.into())
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn quote(text: &str) -> String {
    text.replace("\r\n", "\n")
        .split('\n')
        .map(|line| format!("> {}", inline(line)))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn image_referenced(body: &str, url: &str) -> bool {
    let mut code_width = None;
    let mut in_comment = false;
    for line in text::lines(body) {
        if !line.visible || line.text.trim().is_empty() {
            code_width = None;
            continue;
        }
        // Deliberately conservative: indented code and literal image examples
        // cannot establish that a managed attachment belongs to this Space.
        if line.text.starts_with("    ") || line.text.starts_with('\t') {
            continue;
        }
        let bytes = line.text.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if in_comment {
                if let Some(end) = line.text[index..].find("-->") {
                    index += end + 3;
                    in_comment = false;
                } else {
                    break;
                }
                continue;
            }
            if code_width.is_none() && bytes[index..].starts_with(b"<!--") {
                in_comment = true;
                index += 4;
                continue;
            }
            if bytes[index] == b'\\' && code_width.is_none() {
                index += 1;
                if index < bytes.len() {
                    index += line.text[index..].chars().next().unwrap().len_utf8();
                }
                continue;
            }
            if bytes[index] == b'`' {
                let width = bytes[index..]
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                if code_width == Some(width) {
                    code_width = None;
                } else if code_width.is_none() {
                    code_width = Some(width);
                }
                index += width;
                continue;
            }
            if code_width.is_none() && bytes[index..].starts_with(b"![") {
                let mut label_end = index + 2;
                let mut depth = 1;
                while label_end < bytes.len() {
                    if bytes[label_end] == b'\\' {
                        label_end += 2;
                        continue;
                    }
                    if bytes[label_end] == b'[' {
                        depth += 1;
                    }
                    if bytes[label_end] == b']' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    label_end += 1;
                }
                if label_end < bytes.len() && bytes[label_end..].starts_with(b"](") {
                    if let Some(tail) = line.text[label_end + 2..].strip_prefix(url) {
                        if tail.starts_with(')') {
                            return true;
                        }
                        let title = tail.trim_start_matches([' ', '\t']);
                        if title.len() < tail.len() && title.starts_with(['\'', '"']) {
                            let delimiter = title.as_bytes()[0];
                            let title_bytes = title.as_bytes();
                            let mut end = 1;
                            while end < title_bytes.len() {
                                if title_bytes[end] == b'\\' {
                                    end += 2;
                                    continue;
                                }
                                if title_bytes[end] == delimiter {
                                    if title_bytes.get(end + 1) == Some(&b')') {
                                        return true;
                                    }
                                    break;
                                }
                                end += 1;
                            }
                        }
                    }
                }
            }
            index += line.text[index..].chars().next().unwrap().len_utf8();
        }
    }
    false
}

fn validate_block_destination(body: &str) -> Result<(), ToolFailure> {
    let mut depth = 0usize;
    let mut fence: Option<(u8, usize)> = None;
    for line in body.lines() {
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let marker = trimmed.as_bytes().first().copied().unwrap_or(b' ');
        let count = trimmed.bytes().take_while(|byte| *byte == marker).count();
        if let Some((open, width)) = fence {
            if indent <= 3 && marker == open && count >= width && trimmed[count..].trim().is_empty()
            {
                fence = None;
            }
            continue;
        }
        if indent <= 3
            && matches!(marker, b'`' | b'~')
            && count >= 3
            && (marker == b'~' || !trimmed[count..].contains('`'))
        {
            fence = Some((marker, count));
        } else if line == BLOCK_OPEN {
            depth += 1;
            if depth > 1 {
                return Err(invalid("A writing block cannot be inserted inside another block. Select the complete existing block or insert outside it."));
            }
        } else if line == BLOCK_CLOSE {
            if depth == 0 {
                return Err(invalid(
                    "The destination contains an unmatched block marker.",
                ));
            }
            depth -= 1;
        }
    }
    if depth != 0 || fence.is_some() {
        return Err(invalid("Close the destination's block markers and code fences before inserting a writing block."));
    }
    Ok(())
}

/// Inserting formatting into code or frontmatter would turn it into literal
/// content or corrupt metadata. Whole-region selections remain explicit edits.
fn protected_regions(body: &str) -> (usize, Vec<(usize, usize, bool)>) {
    let lines: Vec<_> = body.split_inclusive('\n').collect();
    let mut regions = Vec::new();
    let frontmatter_end = if lines.first().is_some_and(|line| line.trim_end() == "---") {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| matches!(line.trim_end(), "---" | "..."))
            .map(|(index, _)| lines[..=index].iter().map(|line| line.len()).sum())
            .unwrap_or(0)
    } else {
        0
    };
    if frontmatter_end > 0 {
        regions.push((0, frontmatter_end, false));
    }
    let mut byte = 0;
    let mut fence: Option<(u8, usize, usize)> = None;
    for raw in lines {
        let start = byte;
        byte += raw.len();
        if start < frontmatter_end {
            continue;
        }
        let line = raw.trim_end_matches(['\r', '\n']);
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            continue;
        }
        let marker = trimmed.as_bytes().first().copied().unwrap_or(b' ');
        let count = trimmed.bytes().take_while(|c| *c == marker).count();
        if let Some((open, width, from)) = fence {
            if marker == open && count >= width && trimmed[count..].trim().is_empty() {
                regions.push((from, byte, false));
                fence = None;
            }
        } else if matches!(marker, b'`' | b'~')
            && count >= 3
            && (marker == b'~' || !trimmed[count..].contains('`'))
        {
            fence = Some((marker, count, start));
        }
    }
    if let Some((_, _, start)) = fence {
        regions.push((start, body.len(), true));
    }
    (frontmatter_end, regions)
}

pub(super) fn apply(
    scope: &Space,
    current: &Note,
    args: &Map<String, Value>,
) -> Result<String, ToolFailure> {
    let command = arg(args, "command");
    if matches!(command, "inline_format" | "unlink") {
        return editor_inline::apply(current, args);
    }
    if matches!(command, "table_layout" | "table_edit") {
        return editor_table::apply(current, args);
    }
    if matches!(
        command,
        "paragraph_format" | "document_margins" | "image_layout"
    ) {
        return editor_layout::apply(current, args);
    }
    let specific: &[&str] = match command {
        "text" | "block" | "quote" => &["text"],
        "heading" => &["text", "level"],
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => &["text"],
        "todo" | "bullet" | "numbered" => &["items"],
        "divider" => &[], "code" => &["text", "language"],
        "table" => &["rows", "header"], "link" => &["target_note_id", "url", "text"],
        "excerpt" => &["target_note_id", "target_expected_version", "text"],
        "image" => &["image_url", "alt"],
        _ => return Err(invalid("Unsupported command. Use a documented formatting command or orion_edit_note_text for exact table deletion.")),
    };
    for key in args.keys() {
        if ![
            "space_id",
            "note_id",
            "expected_version",
            "command",
            "placement",
            "anchor",
        ]
        .contains(&key.as_str())
            && !specific.contains(&key.as_str())
        {
            return Err(invalid(&format!(
                "{key} is not used by the {command} command."
            )));
        }
    }
    if !matches!(command, "block" | "code") {
        if let Some(text) = args.get("text").and_then(Value::as_str) {
            literal_indentation(text)?;
        }
    }
    let placement = args
        .get("placement")
        .and_then(Value::as_str)
        .unwrap_or("append");
    let anchor = arg(args, "anchor");
    let selected = if matches!(placement, "before" | "after" | "replace") {
        Some(exact_index(&current.body, anchor)?)
    } else {
        if args.contains_key("anchor") {
            return Err(invalid(
                "anchor is only accepted for before, after, or replace.",
            ));
        }
        None
    };
    let (frontmatter_end, protected) = protected_regions(&current.body);
    let (from, to) = match placement {
        "append" => (current.body.len(), current.body.len()),
        "prepend" => (frontmatter_end, frontmatter_end),
        "before" => (selected.unwrap(), selected.unwrap()),
        "after" => (
            selected.unwrap() + anchor.len(),
            selected.unwrap() + anchor.len(),
        ),
        "replace" => (selected.unwrap(), selected.unwrap() + anchor.len()),
        _ => return Err(invalid("Invalid placement.")),
    };
    if protected.iter().any(|(start, end, unclosed)| {
        [from, to].into_iter().any(|position| {
            (position > *start && position < *end) || (*unclosed && position >= *start)
        })
    }) {
        return Err(invalid("Select content outside frontmatter and fenced code, or select the complete closed region. Use orion_edit_note_text for a literal edit inside it."));
    }
    let markdown = match command {
        "text" => inline(require_text(args)?),
        "block" => block(
            args.get("text")
                .and_then(Value::as_str)
                .unwrap_or(if placement == "replace" { anchor } else { "" }),
        )?,
        "heading" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = if command == "heading" {
                number(args, "level", 2)
            } else {
                command.as_bytes()[1] as usize - b'0' as usize
            };
            format!(
                "{} {}",
                "#".repeat(level),
                single_line(require_text(args)?)?
            )
        }
        "todo" | "bullet" | "numbered" => {
            let items = args
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("Provide items for this list command."))?;
            let mut lines = Vec::new();
            for (index, item) in items.iter().enumerate() {
                if command != "todo" && item.get("checked").is_some() {
                    return Err(invalid("checked is only valid for todo items."));
                }
                let label = single_line(item["text"].as_str().unwrap())?;
                let prefix = match command {
                    "todo" => {
                        if item["checked"].as_bool().unwrap_or(false) {
                            "- [x] ".into()
                        } else {
                            "- [ ] ".into()
                        }
                    }
                    "numbered" => format!("{}. ", index + 1),
                    _ => "- ".into(),
                };
                lines.push(format!("{prefix}{label}"));
            }
            lines.join("\n")
        }
        "divider" => "---".into(),
        "quote" => quote(require_text(args)?),
        "code" => {
            let text = require_text(args)?;
            let language = arg(args, "language");
            if !language
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_+-".contains(&c))
            {
                return Err(invalid("Invalid code language identifier."));
            }
            let mut longest = 0usize;
            let mut run = 0usize;
            for c in text.chars() {
                if c == '`' {
                    run += 1;
                    longest = longest.max(run);
                } else {
                    run = 0;
                }
            }
            let fence = "`".repeat((longest + 1).max(3));
            format!(
                "{fence}{language}\n{text}{}{fence}",
                if text.ends_with('\n') { "" } else { "\n" }
            )
        }
        "table" => {
            let rows = args
                .get("rows")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("Provide rows for the table."))?;
            let width = rows[0].as_array().unwrap().len();
            let mut lines = Vec::new();
            for row in rows {
                let cells = row.as_array().unwrap();
                if cells.len() != width {
                    return Err(invalid(
                        "Every table row must have the same number of cells.",
                    ));
                }
                let cells = cells
                    .iter()
                    .map(|cell| {
                        inline(cell.as_str().unwrap())
                            .replace("\r\n", "\n")
                            .replace(['\n', '\r'], "<br>")
                    })
                    .collect::<Vec<_>>();
                lines.push(format!("| {} |", cells.join(" | ")));
            }
            let header = args.get("header").and_then(Value::as_bool).unwrap_or(true);
            if !header {
                lines.insert(0, format!("| {} |", vec![""; width].join(" | ")));
            }
            lines.insert(1, format!("| {} |", vec!["---"; width].join(" | ")));
            let metadata = if header {
                String::new()
            } else {
                format!(
                    "<!-- orion-table:v1 {} -->\n",
                    json!({"width":100,"banded":true,"header":false,"columns":vec![Value::Null;width]})
                )
            };
            format!("{metadata}{}", lines.join("\n"))
        }
        "link" => {
            match (args.get("url"), args.get("target_note_id")) {
                (Some(url), None) => {
                    let url = external_link(url.as_str().unwrap_or(""))?;
                    let label = args
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(if placement == "replace" { anchor } else { &url });
                    // WHATWG leaves parentheses in paths. Encode them so even an
                    // unmatched closing parenthesis cannot escape Markdown's href.
                    let destination = url.replace('(', "%28").replace(')', "%29");
                    format!("[{}]({destination})", single_line(label)?)
                }
                (None, Some(_)) => {
                    let target = target(scope, args)?;
                    let label = args
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(&target.title);
                    format!("[{}](orion-note://{})", single_line(label)?, target.id)
                }
                _ => {
                    return Err(invalid(
                        "Supply exactly one link destination: url or target_note_id.",
                    ))
                }
            }
        }
        "excerpt" => {
            let target = target(scope, args)?;
            if note_version(target) != arg(args, "target_expected_version") {
                return Err(conflict());
            }
            let text = require_text(args)?;
            if text.encode_utf16().count() > 12_000 {
                return Err(invalid(
                    "Choose an excerpt of at most 12,000 UTF-16 characters.",
                ));
            }
            exact_index(&target.body, text)?;
            let metadata =
                percent_encode(&json!({"noteId":target.id,"passages":[{"text":text}]}).to_string());
            if metadata.len() > 80_000 {
                return Err(invalid("This excerpt is too large to preserve."));
            }
            format!(
                "{}\n>\n> [{}](orion-note://{} \"orion-excerpt:v2:{metadata}\")",
                quote(text),
                single_line(&target.title)?,
                target.id
            )
        }
        "image" => {
            let url = arg(args, "image_url");
            let asset = url.strip_prefix("orion-image://localhost/").unwrap_or("");
            if !(12..=80).contains(&asset.len())
                || !asset
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                || !scope
                    .notes
                    .iter()
                    .any(|note| image_referenced(&note.body, url))
            {
                return Err(invalid("Reuse an existing managed image referenced in this Space, or import the image through Orion first."));
            }
            format!(
                "![{}]({url})",
                single_line(args.get("alt").and_then(Value::as_str).unwrap_or("Image"))?
            )
        }
        _ => unreachable!(),
    };
    if markdown.chars().count() > 100_000 {
        return Err(invalid(
            "Formatted content exceeds the 100,000-character command limit.",
        ));
    }
    let body = if command == "link" && matches!(placement, "before" | "after" | "replace") {
        format!(
            "{}{}{}",
            &current.body[..from],
            markdown,
            &current.body[to..]
        )
    } else {
        join_blocks(
            &join_blocks(&current.body[..from], &markdown),
            &current.body[to..],
        )
    };
    if command == "block" {
        validate_block_destination(&body)?;
    }
    Ok(body)
}
