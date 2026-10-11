//! Finite source-citation edits. Source bytes stay intact outside the selected
//! marker and the renderer-owned citation numbers/trailing References section.
use super::editor::{exact_index, invalid, PreparedEdit};
use super::*;
use pulldown_cmark::{CodeBlockKind, Event, LinkType, Options, Parser, Tag};
use std::ops::Range;

#[derive(Clone)]
struct Citation {
    range: Range<usize>,
    label: String,
    id: String,
}
fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}
fn overlap(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && b.start < a.end
}
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}'
}
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 200
        && !id.chars().any(|c| {
            c.is_whitespace()
                || js_space(c)
                || c.is_control()
                || matches!(
                    c,
                    '(' | ')' | '[' | ']' | '<' | '>' | '"' | '\\' | '?' | '#' | '&' | '|' | '`'
                )
        })
}
fn link_at(text: &str, start: usize) -> Option<Citation> {
    if text.as_bytes().get(start) != Some(&b'[') {
        return None;
    }
    let mut escaped = false;
    let mut end = None;
    for (offset, c) in text[start + 1..].char_indices() {
        if matches!(c, '\r' | '\n') {
            return None;
        }
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '[' {
            return None;
        }
        if c == ']' {
            end = Some(start + 1 + offset);
            break;
        }
    }
    let end = end?;
    let target = text.get(end + 1..)?.strip_prefix("(orion-source://")?;
    let length = target.find(')')?;
    let id = &target[..length];
    if !safe_id(id) {
        return None;
    }
    Some(Citation {
        range: start..end + 1 + "(orion-source://".len() + length + 1,
        label: text[start + 1..end].into(),
        id: id.into(),
    })
}
fn unescape(label: &str) -> String {
    let mut out = String::new();
    let mut chars = label.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some_and(|c| matches!(c, '\\' | '[' | ']')) {
            out.push(chars.next().unwrap());
        } else {
            out.push(c);
        }
    }
    out
}
fn escape_title(title: &str) -> String {
    let mut out = String::new();
    let mut newline = false;
    for c in title.chars() {
        if matches!(c, '\r' | '\n') {
            if !newline {
                out.push(' ');
            }
            newline = true;
        } else {
            newline = false;
            if matches!(c, '\\' | '[' | ']') {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out
}
fn frontmatter_end(body: &str) -> usize {
    let lines: Vec<_> = body.split_inclusive('\n').collect();
    if lines
        .first()
        .is_none_or(|s| !s.ends_with('\n') || s.trim_end_matches([' ', '\t', '\r', '\n']) != "---")
    {
        return 0;
    }
    let mut offset = lines[0].len();
    for line in &lines[1..] {
        offset += line.len();
        if line.ends_with('\n') && line.trim_end_matches([' ', '\t', '\r', '\n']) == "---" {
            while body[offset..].starts_with('\n') || body[offset..].starts_with("\r\n") {
                offset += if body[offset..].starts_with('\r') {
                    2
                } else {
                    1
                };
            }
            return offset;
        }
    }
    0
}

/// Use actual Markdown spans to avoid treating code/HTML/reference definitions
/// as editable prose. The renderer protects ordinary fenced and inline code;
/// other source-link spellings fail closed instead of changing on next reopen.
fn citations(body: &str) -> Result<Vec<Citation>, ToolFailure> {
    let mut links = BTreeSet::new();
    let mut code = Vec::new();
    let mut image_depth = 0usize;
    for (event, range) in Parser::new_ext(body, options()).into_offset_iter() {
        match event {
            Event::Start(Tag::Image { .. }) => image_depth += 1,
            Event::End(pulldown_cmark::TagEnd::Image) => {
                image_depth = image_depth.saturating_sub(1)
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                ..
            }) if dest_url.starts_with("orion-source://") => {
                if image_depth > 0 || link_type != LinkType::Inline || !title.is_empty() {
                    return Err(invalid("Source citations must use a plain inline source link, without a title or reference-style definition."));
                }
                let link = link_at(body, range.start).filter(|link| link.range == range)
                    .ok_or_else(|| invalid("This source citation has unsupported nested or encoded Markdown syntax."))?;
                if dest_url.as_ref() != format!("orion-source://{}", link.id) {
                    return Err(invalid("The Markdown citation destination must preserve the exact source ID without entity decoding."));
                }
                links.insert((link.range.start, link.range.end));
            }
            Event::Code(_) if !body[range.clone()].contains(['\r', '\n']) => code.push(range),
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_))) => {
                // A container-prefixed/indented fence is not protected by the
                // renderer's citation grammar. Do not claim parity for it.
                let start = body[..range.start].rfind('\n').map_or(0, |i| i + 1);
                if body[start..range.start].len() <= 3
                    && body[start..range.start].bytes().all(|b| b == b' ')
                {
                    let raw = &body[range.clone()];
                    let first = raw.lines().next().unwrap_or("").trim_start_matches(' ');
                    let marker = first.as_bytes().first().copied().unwrap_or(b' ');
                    let width = first.bytes().take_while(|c| *c == marker).count();
                    let last = raw
                        .trim_end_matches(['\r', '\n'])
                        .rsplit('\n')
                        .next()
                        .unwrap_or("")
                        .trim_matches([' ', '\t', '\r']);
                    if raw.contains('\n')
                        && (last.len() != width || !last.bytes().all(|c| c == marker))
                    {
                        return Err(invalid("Close fenced examples with the same delimiter length before editing citations."));
                    }
                    code.push(range);
                }
            }
            _ => {}
        }
    }
    code.sort_by_key(|range| range.start);
    let mut result = Vec::new();
    let mut code_index = 0;
    for (index, _) in body.match_indices('[') {
        if index > 0 && matches!(body.as_bytes()[index - 1], b'!' | b'\\') {
            continue;
        }
        let Some(link) = link_at(body, index) else {
            continue;
        };
        while code_index < code.len() && code[code_index].end <= index {
            code_index += 1;
        }
        if code
            .get(code_index)
            .is_some_and(|range| overlap(range, &link.range))
        {
            continue;
        }
        if !links.contains(&(link.range.start, link.range.end)) {
            return Err(invalid("A source-link example is inside unsupported HTML, metadata or code. Preserve it with an exact text edit."));
        }
        result.push(link);
    }
    Ok(result)
}
fn footer(body: &str) -> (String, BTreeMap<String, String>) {
    let lines = text::lines(body);
    let safe = editor_layout::safe_lines(body);
    for (i, line) in lines.iter().enumerate().rev() {
        let heading = line.text.trim_start_matches(' ');
        if !safe[i]
            || line.text.len() - heading.len() > 3
            || !heading.strip_prefix("##").is_some_and(|s| {
                s.starts_with([' ', '\t']) && s.trim_matches([' ', '\t', '\r']) == "References"
            })
        {
            continue;
        }
        let entries: Vec<_> = lines[i + 1..]
            .iter()
            .map(|l| js_trim(&l.text))
            .filter(|l| !l.is_empty())
            .collect();
        if entries.is_empty() {
            break;
        }
        let mut titles = BTreeMap::new();
        let mut valid = true;
        for entry in entries {
            let digits = entry.bytes().take_while(u8::is_ascii_digit).count();
            let rest = entry.get(digits..).and_then(|s| s.strip_prefix('.'));
            let Some(rest) = rest.filter(|s| digits > 0 && s.starts_with(js_space)) else {
                valid = false;
                break;
            };
            let rest = js_trim(rest);
            let Some(link) = link_at(rest, 0).filter(|l| l.range.end == rest.len()) else {
                valid = false;
                break;
            };
            titles.insert(link.id, unescape(&link.label));
        }
        if valid {
            let mut end = line.byte;
            let original = end;
            for _ in 0..2 {
                if body[..end].ends_with("\r\n") {
                    end -= 2;
                } else if body[..end].ends_with('\n') {
                    end -= 1;
                } else {
                    end = original;
                    break;
                }
            }
            return (body[..end].into(), titles);
        }
        // An earlier candidate contains this later heading in its tail, so it
        // cannot consist solely of numbered source-reference lines either.
        break;
    }
    (body.into(), BTreeMap::new())
}
fn canonical(
    scope: &Space,
    body: &str,
    titles: &BTreeMap<String, String>,
) -> Result<String, ToolFailure> {
    let links = citations(body)?;
    let mut source_by_id: BTreeMap<&str, Vec<&Source>> = BTreeMap::new();
    for source in &scope.sources {
        source_by_id.entry(&source.id).or_default().push(source);
    }
    let mut references: Vec<(String, String)> = Vec::new();
    let mut numbers = BTreeMap::new();
    let mut result = String::new();
    let mut cursor = 0;
    for link in links {
        let number = if let Some(number) = numbers.get(&link.id) {
            *number
        } else {
            let sources = source_by_id
                .get(link.id.as_str())
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if sources.len() > 1 {
                return Err(invalid(
                    "Duplicate source IDs make citation titles ambiguous.",
                ));
            }
            let label = unescape(&link.label);
            let title = sources
                .first()
                .map(|s| js_trim(&s.title))
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    titles
                        .get(&link.id)
                        .map(|s| js_trim(s))
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or_else(|| {
                    if !js_trim(&label).is_empty()
                        && !js_trim(&label).bytes().all(|c| c.is_ascii_digit())
                    {
                        js_trim(&label)
                    } else {
                        "Unavailable source"
                    }
                });
            references.push((link.id.clone(), title.into()));
            let number = references.len();
            numbers.insert(link.id.clone(), number);
            number
        };
        result.push_str(&body[cursor..link.range.start]);
        result.push_str(&format!("[{number}](orion-source://{})", link.id));
        cursor = link.range.end;
    }
    result.push_str(&body[cursor..]);
    if !references.is_empty() {
        result.push_str("\n\n## References\n\n");
        for (i, (id, title)) in references.iter().enumerate() {
            if i > 0 {
                result.push('\n');
            }
            result.push_str(&format!(
                "{}. [{}](orion-source://{id})",
                i + 1,
                escape_title(title)
            ));
        }
    }
    Ok(result)
}

/// Anchor insertion is restricted to one real prose text span, never a link's
/// destination/delimiter or a structural/code/metadata boundary.
fn insertion_point(body: &str, anchor: &str, after: bool) -> Result<usize, ToolFailure> {
    let start = exact_index(body, anchor)?;
    let selected = start..start + anchor.len();
    let safe = editor_layout::safe_lines(body);
    if text::lines(body)
        .iter()
        .enumerate()
        .any(|(i, l)| !safe[i] && overlap(&selected, &(l.byte..l.byte + l.text.len())))
    {
        return Err(invalid(
            "Choose a citation anchor in prose, outside code, HTML, metadata and frontmatter.",
        ));
    }
    let mut link_depth = 0usize;
    let mut allowed = false;
    let block = Parser::new_ext(body, options())
        .into_offset_iter()
        .find_map(|(event, range)| {
            matches!(
                event,
                Event::Start(Tag::Paragraph | Tag::Heading { .. } | Tag::TableCell)
            )
            .then_some(range)
            .filter(|range| range.start <= selected.start && range.end >= selected.end)
        })
        .ok_or_else(|| {
            invalid("Choose one prose paragraph, heading or table cell for the citation anchor.")
        })?;
    for (event, range) in Parser::new_ext(body, options()).into_offset_iter() {
        match event {
            Event::Start(Tag::Link { .. } | Tag::Image { .. }) => link_depth += 1,
            Event::End(pulldown_cmark::TagEnd::Link | pulldown_cmark::TagEnd::Image) => {
                link_depth = link_depth.saturating_sub(1)
            }
            Event::Text(text)
                if link_depth == 0 && range.start >= block.start && range.end <= block.end =>
            {
                // Marked additionally links bare GFM URLs/emails which this
                // parser reports as text. Reject that containing prose rather
                // than insert into an actual rendered link or its query.
                if text.contains("://")
                    || text.to_ascii_lowercase().contains("www.")
                    || text.contains('@')
                {
                    return Err(invalid("A prose block with bare web/email autolinks needs an exact text edit or a boundary citation insertion."));
                }
                if range.start <= selected.start && range.end >= selected.end {
                    if body[range.clone()] != *text {
                        return Err(invalid("Choose plain citation anchor text without escaped characters or entities."));
                    }
                    allowed = true;
                }
            }
            _ => {}
        }
    }
    if !allowed {
        return Err(invalid(
            "Use a unique plain-prose anchor without Markdown delimiters or link syntax.",
        ));
    }
    Ok(if after { selected.end } else { selected.start })
}

pub(super) fn apply(
    scope: &Space,
    current: &Note,
    args: &Map<String, Value>,
) -> Result<PreparedEdit, ToolFailure> {
    let action = arg(args, "citation_action");
    let allowed = [
        "space_id",
        "note_id",
        "expected_version",
        "command",
        "citation_action",
        "source_id",
        "source_expected_version",
        "placement",
        "anchor",
    ];
    if args.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid("Source citations do not accept replacement text, titles, numbers or unrelated formatting fields."));
    }
    let id = arg(args, "source_id");
    if !safe_id(id) {
        return Err(invalid("Supply an exact link-safe source_id."));
    }
    let prefix_end = frontmatter_end(&current.body);
    let prefix = &current.body[..prefix_end];
    let (mut body, titles) = footer(&current.body[prefix_end..]);
    let before = citations(&body)?;
    let attachment;
    match action {
        "insert" => {
            let target = source(scope, id)?;
            if source_version(target) != arg(args, "source_expected_version") {
                return Err(conflict());
            }
            let placement = args
                .get("placement")
                .and_then(Value::as_str)
                .unwrap_or("append");
            let marker = format!("[1](orion-source://{id})");
            if matches!(placement, "append" | "prepend") {
                if args.contains_key("anchor") {
                    return Err(invalid(
                        "Boundary citation insertion does not accept an anchor.",
                    ));
                }
                let newline = if body.contains("\r\n") { "\r\n" } else { "\n" };
                body = if body.is_empty() {
                    marker
                } else if placement == "append" {
                    format!("{body}{newline}{newline}{marker}")
                } else {
                    format!("{marker}{newline}{newline}{body}")
                };
            } else if matches!(placement, "before" | "after") {
                let index = insertion_point(&body, arg(args, "anchor"), placement == "after")?;
                let previous = body[..index].chars().next_back();
                let next = body[index..].chars().next();
                let leading =
                    previous.is_some_and(|c| !c.is_whitespace() && !"([{“‘\"'".contains(c));
                let trailing =
                    next.is_some_and(|c| !c.is_whitespace() && !".,;:!?)}]”’\"'".contains(c));
                body.insert_str(
                    index,
                    &format!(
                        "{}{marker}{}",
                        if leading { " " } else { "" },
                        if trailing { " " } else { "" }
                    ),
                );
            } else {
                return Err(invalid(
                    "Citations support append, prepend, before or after, never replacement.",
                ));
            }
            if citations(&body)?.len() != before.len() + 1 {
                return Err(invalid("The citation would land inside code or unsupported Markdown. Nothing was attached."));
            }
            attachment = Some(id.into());
        }
        "remove" => {
            if args.contains_key("placement") || args.contains_key("source_expected_version") {
                return Err(invalid("Citation removal takes only its exact anchor and source_id; provenance is retained."));
            }
            let anchor = arg(args, "anchor");
            let start = exact_index(&body, anchor)?;
            let range = start..start + anchor.len();
            let selected: Vec<_> = before
                .iter()
                .filter(|l| overlap(&range, &l.range))
                .collect();
            if selected.len() != 1
                || selected[0].id != id
                || selected[0].range.start < range.start
                || selected[0].range.end > range.end
            {
                return Err(invalid(
                    "The unique anchor must contain exactly one complete matching source citation.",
                ));
            }
            let link = selected[0];
            let label = unescape(&link.label);
            let generated = !js_trim(&label).is_empty()
                && js_trim(&label).bytes().all(|c| c.is_ascii_digit())
                && titles.contains_key(id);
            let mut range = link.range.clone();
            let replacement = if generated {
                if body[range.end..]
                    .chars()
                    .next()
                    .is_some_and(|c| " \t\n.,;:!?)}]".contains(c))
                {
                    while range.start > 0
                        && matches!(body.as_bytes()[range.start - 1], b' ' | b'\t')
                    {
                        range.start -= 1;
                    }
                }
                String::new()
            } else {
                // Removing the wrapper must not invent Markdown by unescaping
                // the authored label, or erase its existing inline marks.
                link.label.clone()
            };
            body.replace_range(range, &replacement);
            attachment = None;
        }
        _ => return Err(invalid("Choose citation_action insert or remove.")),
    }
    Ok(PreparedEdit {
        body: format!("{prefix}{}", canonical(scope, &body, &titles)?),
        attach_source: attachment,
    })
}
