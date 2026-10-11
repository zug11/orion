//! Version-guarded inline edits, using source spans rather than reserializing notes.
//! The parser proves text and non-target marks unchanged before write::call saves.
use super::editor::{exact_index, inline, invalid};
use super::*;
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use std::ops::Range;
use std::sync::Arc;

const BOLD: u8 = 1;
const ITALIC: u8 = 2;
const STRIKE: u8 = 4;
const CODE: u8 = 8;
const MAX_ANCHOR: usize = 20_000;
const MAX_CONTAINER: usize = 50_000;

// Match CommonMark's literal code-span normalization. The editor uses the same
// dynamic delimiter contract when saving; edge spaces need padding only when
// both edges are ASCII spaces, while all-space spans must remain unpadded.
fn code_span(literal: &str) -> String {
    let longest = literal
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    let padding = literal.starts_with('`')
        || literal.ends_with('`')
        || (literal.starts_with(' ')
            && literal.ends_with(' ')
            && literal.chars().any(|character| character != ' '));
    if padding {
        format!("{fence} {literal} {fence}")
    } else {
        format!("{fence}{literal}{fence}")
    }
}

fn options() -> Options {
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Link {
    href: String,
    title: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Glyph {
    character: char,
    marks: u8,
    link: Option<Arc<Link>>,
    // Keep hard/soft line breaks distinct, even though both contain a newline.
    line_break: u8,
}
#[derive(Clone, Debug)]
enum Kind {
    Mark(u8),
    Link(Arc<Link>, bool),
}
#[derive(Clone, Debug)]
struct Span {
    kind: Kind,
    source: Range<usize>,
    content: Range<usize>,
}
#[derive(Debug)]
struct Projection {
    glyphs: Vec<Glyph>,
    sources: Vec<Range<usize>>,
    spans: Vec<Span>,
    comments: Vec<(usize, String)>,
    root: String,
}

fn overlap(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && b.start < a.end
}
fn contains(outer: &Range<usize>, inner: &Range<usize>) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// Match the renderer's generated trailing source footer conservatively. Its
/// heading is part of the read-only citation surface, not authored formatting.
fn managed_footer(body: &str) -> Option<usize> {
    let lines = text::lines(body);
    let safe = editor_layout::safe_lines(body);
    for (i, line) in lines.iter().enumerate().rev() {
        let heading = line.text.trim_start_matches(' ');
        let title = heading.strip_prefix("##");
        if !safe[i]
            || line.text.len() - heading.len() > 3
            || !title.is_some_and(|title| {
                title.starts_with([' ', '\t'])
                    && title.trim_matches([' ', '\t', '\r']) == "References"
            })
        {
            continue;
        }
        let entries: Vec<_> = lines[i + 1..]
            .iter()
            .map(|line| line.text.trim())
            .filter(|line| !line.is_empty())
            .collect();
        if !entries.is_empty()
            && entries.iter().all(|line| {
                let digits = line.bytes().take_while(u8::is_ascii_digit).count();
                let Some(rest) = line.get(digits..).and_then(|rest| rest.strip_prefix('.')) else {
                    return false;
                };
                if digits == 0 || !rest.starts_with(char::is_whitespace) {
                    return false;
                }
                let rest = rest.trim();
                rest.starts_with('[') && rest.ends_with(')') && rest.contains("](orion-source://")
            })
        {
            return Some(line.byte);
        }
    }
    None
}

/// Marked's GFM bare URL/email autolinks are wider than CommonMark's parser.
/// Do not claim a semantic proof for a paragraph relying on that extension.
fn bare_autolink_hazard(projection: &Projection) -> bool {
    let mut run = String::new();
    let risky = |text: &str| {
        text.contains("://") || text.to_ascii_lowercase().contains("www.") || text.contains('@')
    };
    for glyph in &projection.glyphs {
        if glyph.link.is_some() || glyph.marks & CODE != 0 {
            if risky(&run) {
                return true;
            }
            run.clear();
        } else {
            run.push(glyph.character);
        }
    }
    risky(&run)
}

/// Use the entire note to resolve containers and reference definitions. Only an
/// ordinary top-level paragraph/ATX heading is editable; Orion frame comments
/// are separate blocks and therefore remain untouched.
fn container(body: &str, selected: &Range<usize>) -> Result<Range<usize>, ToolFailure> {
    let safe = editor_layout::safe_lines(body);
    let lines = text::lines(body);
    if lines
        .iter()
        .enumerate()
        .any(|(i, line)| overlap(selected, &(line.byte..line.byte + line.text.len())) && !safe[i])
    {
        return Err(invalid(
            "Select inline prose outside frontmatter, code, HTML and reference definitions.",
        ));
    }
    let mut depth = 0usize;
    let mut found = None;
    for (event, range) in Parser::new_ext(body, options()).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if matches!(&tag, Tag::Link { link_type, .. } if *link_type != LinkType::Inline)
                    && found.as_ref().is_some_and(|block| contains(block, &range))
                {
                    return Err(invalid(
                        "Reference-style links and autolinks require an exact text edit.",
                    ));
                }
                if depth == 0
                    && matches!(tag, Tag::Paragraph | Tag::Heading { .. })
                    && contains(&range, selected)
                {
                    if matches!(tag, Tag::Heading { .. })
                        && !body[range.clone()].trim_start().starts_with('#')
                    {
                        return Err(invalid("Setext headings require an exact text edit; select an ATX heading or ordinary paragraph."));
                    }
                    found = Some(range);
                }
                depth += 1;
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    let mut found = found.ok_or_else(|| invalid("Select inline content within one ordinary paragraph or ATX heading, not a list, table, quote or structural boundary."))?;
    while found.end > found.start && matches!(body.as_bytes()[found.end - 1], b'\r' | b'\n') {
        found.end -= 1;
    }
    if !contains(&found, selected) || body[found.clone()].chars().count() > MAX_CONTAINER {
        return Err(invalid("Select a paragraph or heading of at most 50,000 characters without its trailing line break."));
    }
    Ok(found)
}

fn mark_content(source: &str, range: &Range<usize>, mark: u8) -> Result<Range<usize>, ToolFailure> {
    let raw = &source[range.clone()];
    let width = match mark {
        BOLD => 2,
        ITALIC => 1,
        STRIKE => {
            if !raw.starts_with("~~") || !raw.ends_with("~~") {
                return Err(invalid("Use the portable double-tilde strikethrough form."));
            }
            2
        }
        CODE => raw.bytes().take_while(|c| *c == b'`').count(),
        _ => unreachable!(),
    };
    if width == 0 || range.len() <= width * 2 {
        return Err(invalid("The inline delimiters cannot be edited safely."));
    }
    Ok(range.start + width..range.end - width)
}

fn link_content(source: &str, range: &Range<usize>) -> Option<Range<usize>> {
    let raw = &source[range.clone()];
    if !raw.starts_with('[') {
        return None;
    }
    let mut depth = 1usize;
    let mut escaped = false;
    for (offset, c) in raw.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '[' {
            depth += 1;
        }
        if c == ']' {
            depth -= 1;
            if depth == 0 {
                return raw[offset..]
                    .starts_with("](")
                    .then_some(range.start + 1..range.start + offset);
            }
        }
    }
    None
}

fn project(source: &str) -> Result<Projection, ToolFailure> {
    let mut output = Projection {
        glyphs: vec![],
        sources: vec![],
        spans: vec![],
        comments: vec![],
        root: String::new(),
    };
    let mut stack: Vec<usize> = vec![];
    let mut roots = 0;
    for (event, range) in Parser::new_ext(source, options()).into_offset_iter() {
        match event {
            Event::Start(Tag::Paragraph) | Event::Start(Tag::Heading { .. }) if roots == 0 => {
                output.root = format!("{event:?}");
                roots += 1;
            }
            Event::Start(tag) => {
                if stack.len() >= 32 {
                    return Err(invalid(
                        "Inline markup is too deeply nested for a bounded formatting edit.",
                    ));
                }
                let kind = match tag {
                    Tag::Strong => Kind::Mark(BOLD),
                    Tag::Emphasis => Kind::Mark(ITALIC),
                    Tag::Strikethrough => Kind::Mark(STRIKE),
                    Tag::Link {
                        link_type,
                        dest_url,
                        title,
                        ..
                    } => Kind::Link(
                        Arc::new(Link {
                            href: dest_url.into_string(),
                            title: title.into_string(),
                        }),
                        link_type == LinkType::Inline,
                    ),
                    _ => return Err(invalid(
                        "The selected paragraph contains unsupported inline or block structure.",
                    )),
                };
                let content = match &kind {
                    Kind::Mark(mark) => mark_content(source, &range, *mark)?,
                    Kind::Link(_, true) => link_content(source, &range).ok_or_else(|| {
                        invalid("Select a complete ordinary inline link with a balanced label.")
                    })?,
                    Kind::Link(_, false) => {
                        return Err(invalid(
                            "Reference-style links and autolinks require an exact text edit.",
                        ))
                    }
                };
                stack.push(output.spans.len());
                output.spans.push(Span {
                    kind,
                    source: range,
                    content,
                });
            }
            Event::End(_) => {
                stack.pop();
            }
            Event::InlineHtml(html) if html.starts_with("<!--") && html.ends_with("-->") => {
                output
                    .comments
                    .push((output.glyphs.len(), html.into_string()));
            }
            Event::Text(_) | Event::Code(_) | Event::SoftBreak | Event::HardBreak => {
                let mut marks = 0;
                let mut link = None;
                for index in &stack {
                    match &output.spans[*index].kind {
                        Kind::Mark(mark) => marks |= mark,
                        Kind::Link(value, _) => link = Some(value.clone()),
                    }
                }
                let (value, line_break) = match &event {
                    Event::Text(text) => (text.as_ref(), 0),
                    Event::Code(text) => {
                        let content = mark_content(source, &range, CODE)?;
                        output.spans.push(Span {
                            kind: Kind::Mark(CODE),
                            source: range.clone(),
                            content,
                        });
                        marks |= CODE;
                        (text.as_ref(), 0)
                    }
                    Event::SoftBreak => ("\n", 1),
                    Event::HardBreak => ("\n", 2),
                    _ => unreachable!(),
                };
                // Escapes/entities and normalized code are indivisible. Direct
                // text keeps precise Unicode character boundaries, not UTF-16.
                let direct = matches!(event, Event::Text(_)) && &source[range.clone()] == value;
                for (offset, character) in value.char_indices() {
                    output.sources.push(if direct {
                        range.start + offset..range.start + offset + character.len_utf8()
                    } else {
                        range.clone()
                    });
                    output.glyphs.push(Glyph {
                        character,
                        marks,
                        link: link.clone(),
                        line_break,
                    });
                }
            }
            _ => {
                return Err(invalid(
                    "HTML, images and other embedded content require their own exact edit.",
                ))
            }
        }
    }
    if roots != 1 || !stack.is_empty() {
        return Err(invalid(
            "Select content inside one complete paragraph or heading.",
        ));
    }
    Ok(output)
}

fn selection(
    projection: &Projection,
    selected: &Range<usize>,
) -> Result<Range<usize>, ToolFailure> {
    for span in &projection.spans {
        if overlap(selected, &span.source)
            && !contains(selected, &span.source)
            && !contains(&span.content, selected)
        {
            return Err(invalid("The selection cuts through inline syntax. Include the complete marked span or link."));
        }
    }
    let mut indices = Vec::new();
    for (i, source) in projection.sources.iter().enumerate() {
        if overlap(source, selected) {
            if !contains(selected, source) {
                return Err(invalid(
                    "The selection splits an escaped character, entity or code span.",
                ));
            }
            indices.push(i);
        }
    }
    let first = *indices
        .first()
        .ok_or_else(|| invalid("Select nonempty visible text, not Markdown syntax or metadata."))?;
    let end = indices.last().unwrap() + 1;
    if indices.len() != end - first
        || projection
            .comments
            .iter()
            .any(|(at, _)| *at > first && *at < end)
    {
        return Err(invalid(
            "Select continuous inline text without hidden metadata.",
        ));
    }
    Ok(first..end)
}

fn replace_ranges(
    source: &str,
    mut edits: Vec<(Range<usize>, String)>,
) -> Result<String, ToolFailure> {
    edits.sort_by_key(|(range, _)| range.start);
    if edits.windows(2).any(|pair| pair[0].0.end > pair[1].0.start) {
        return Err(invalid(
            "The selected nested delimiters cannot be changed without an overlapping edit.",
        ));
    }
    let mut result = source.to_owned();
    for (range, replacement) in edits.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    Ok(result)
}

pub(super) fn apply(current: &Note, args: &Map<String, Value>) -> Result<String, ToolFailure> {
    let unlink = arg(args, "command") == "unlink";
    for key in args.keys() {
        if ![
            "space_id",
            "note_id",
            "expected_version",
            "command",
            "anchor",
        ]
        .contains(&key.as_str())
            && (unlink || !["mark", "enabled"].contains(&key.as_str()))
        {
            return Err(invalid(&format!(
                "{key} is not used by this inline command."
            )));
        }
    }
    let anchor = arg(args, "anchor");
    if anchor.trim().is_empty() || anchor.chars().count() > MAX_ANCHOR {
        return Err(invalid(
            "Supply one exact nonempty inline anchor of at most 20,000 characters.",
        ));
    }
    if anchor.contains("<!--") || anchor.contains("-->") {
        return Err(invalid(
            "Inline commands cannot select hidden formatting or provenance metadata.",
        ));
    }
    let mark = if unlink {
        0
    } else {
        match arg(args, "mark") {
            "bold" => BOLD,
            "italic" => ITALIC,
            "strike" => STRIKE,
            "code" => CODE,
            _ => return Err(invalid("Choose bold, italic, strike or code.")),
        }
    };
    let enabled = if unlink {
        false
    } else {
        args.get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                invalid("Supply enabled:true to apply or enabled:false to remove a mark.")
            })?
    };
    let from = exact_index(&current.body, anchor)?;
    let absolute = from..from + anchor.len();
    if managed_footer(&current.body).is_some_and(|start| absolute.end > start) {
        return Err(invalid("The generated References footer is read-only. Use a dedicated source-citation operation."));
    }
    let block = container(&current.body, &absolute)?;
    let source = &current.body[block.clone()];
    let selected = absolute.start - block.start..absolute.end - block.start;
    let before = project(source)?;
    if before
        .glyphs
        .iter()
        .any(|glyph| glyph.character == '\u{a0}')
        && before
            .glyphs
            .iter()
            .all(|glyph| glyph.character.is_whitespace())
    {
        return Err(invalid("The portable blank-paragraph marker is not inline text. Select an ordinary written passage."));
    }
    if bare_autolink_hazard(&before) {
        return Err(invalid("This paragraph contains a bare URL or email address. Use an exact text edit so automatic links remain explicit."));
    }
    if before.spans.iter().any(|span| overlap(&span.source, &selected) && matches!(&span.kind, Kind::Link(link, _) if link.href.starts_with("orion-source://") || link.title.starts_with("orion-"))) {
        return Err(invalid("Source citations and excerpt/passage references require their own operation."));
    }
    let glyph_range = selection(&before, &selected)?;
    let mut expected = before.glyphs.clone();
    let updated;
    if unlink {
        let span = before.spans.iter().find(|span| span.source == selected && matches!(span.kind, Kind::Link(_, true)))
            .ok_or_else(|| invalid("Select exactly one complete explicit Markdown link, including its destination."))?;
        let Kind::Link(link, _) = &span.kind else {
            unreachable!()
        };
        if !["https://", "http://", "orion-note://", "orion-concept://"]
            .iter()
            .any(|prefix| link.href.starts_with(prefix))
            || link.title.starts_with("orion-")
        {
            return Err(invalid("Unlink supports ordinary web, note and concept links only. Source citations and excerpt/passage references require their own operation."));
        }
        for glyph in &mut expected[glyph_range.clone()] {
            glyph.link = None;
        }
        updated = replace_ranges(
            source,
            vec![(selected.clone(), source[span.content.clone()].to_owned())],
        )?;
    } else {
        if before.glyphs[glyph_range.clone()]
            .iter()
            .all(|glyph| (glyph.marks & mark != 0) == enabled)
        {
            return Ok(current.body.clone());
        }
        if mark == CODE
            && enabled
            && before.glyphs[glyph_range.clone()]
                .iter()
                .any(|glyph| glyph.marks != 0 || glyph.link.is_some() || glyph.line_break != 0)
        {
            return Err(invalid("Apply inline code to unformatted single-line text; it must not remove existing marks or links."));
        }
        if mark == CODE
            && !enabled
            && before.glyphs[glyph_range.clone()].iter().any(|glyph| {
                glyph.marks & CODE != 0 && (glyph.marks & !CODE != 0 || glyph.link.is_some())
            })
        {
            return Err(invalid("This code span is nested inside another mark or link that the editor suppresses. Use an exact text edit to choose the resulting formatting."));
        }
        if mark != CODE
            && before.glyphs[glyph_range.clone()]
                .iter()
                .any(|glyph| glyph.marks & CODE != 0)
        {
            return Err(invalid("Inline code is literal. Remove the complete code span before applying another mark."));
        }
        for glyph in &mut expected[glyph_range.clone()] {
            if enabled {
                glyph.marks |= mark;
            } else {
                glyph.marks &= !mark;
            }
        }
        if enabled {
            let replacement = if mark == CODE {
                let literal: String = before.glyphs[glyph_range.clone()]
                    .iter()
                    .map(|glyph| glyph.character)
                    .collect();
                code_span(&literal)
            } else {
                let delimiter = match mark {
                    BOLD => "**",
                    ITALIC => "*",
                    STRIKE => "~~",
                    _ => unreachable!(),
                };
                format!("{delimiter}{anchor}{delimiter}")
            };
            updated = replace_ranges(source, vec![(selected.clone(), replacement)])?;
        } else {
            let mut edits = vec![];
            for span in &before.spans {
                if !matches!(span.kind, Kind::Mark(value) if value == mark)
                    || !overlap(&span.source, &selected)
                {
                    continue;
                }
                if !contains(&selected, &span.source) {
                    return Err(invalid("Removing a mark requires its complete marked span, including both delimiters."));
                }
                if mark == CODE {
                    let first = before
                        .sources
                        .partition_point(|range| range.end <= span.source.start);
                    let literal: String = before
                        .glyphs
                        .iter()
                        .zip(&before.sources)
                        .skip(first)
                        .take_while(|(_, range)| contains(&span.source, range))
                        .map(|(glyph, _)| glyph.character)
                        .collect();
                    edits.push((span.source.clone(), inline(&literal)));
                } else {
                    edits.push((span.source.start..span.content.start, String::new()));
                    edits.push((span.content.end..span.source.end, String::new()));
                }
            }
            updated = replace_ranges(source, edits)?;
        }
    }
    let after = project(&updated)?;
    if bare_autolink_hazard(&after)
        || after.root != before.root
        || after.glyphs != expected
        || after.comments != before.comments
    {
        return Err(invalid("This formatting would change nearby text, another mark or link. Select a complete balanced inline span or use an exact text edit."));
    }
    let mut result = current.body.clone();
    result.replace_range(block, &updated);
    Ok(result)
}
