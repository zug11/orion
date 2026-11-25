//! Determine whether an external write contributed authored text. Status markers,
//! presentation changes and deletions do not establish note-writing provenance.
use pulldown_cmark::{Event, Options, Parser, TagEnd};
use serde_json::{Map, Value};

fn readable(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    let mut result = String::new();
    let mut metadata = false;
    for event in Parser::new_ext(markdown, options) {
        match event {
            Event::Start(pulldown_cmark::Tag::MetadataBlock(_)) => metadata = true,
            Event::End(TagEnd::MetadataBlock(_)) => metadata = false,
            _ if metadata => {}
            Event::Start(pulldown_cmark::Tag::Image { title, .. }) => {
                if let Some(caption) = crate::library::image_caption(&title) {
                    result.push(' ');
                    result.push_str(&caption);
                    result.push(' ');
                }
            }
            Event::Text(text) | Event::Code(text) => result.push_str(&text),
            Event::SoftBreak
            | Event::HardBreak
            | Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::TableCell
                | TagEnd::CodeBlock,
            ) => result.push(' '),
            _ => {}
        }
    }
    result
}

pub(super) fn added_text(before: &str, after: &str) -> bool {
    if before.len() >= after.len() {
        let prefix = before
            .bytes()
            .zip(after.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        if before.as_bytes()[prefix..].ends_with(&after.as_bytes()[prefix..]) {
            return false;
        }
    }
    // Removing words or changing only whitespace leaves a subsequence of the original.
    let mut previous = before.split_whitespace();
    after
        .split_whitespace()
        .any(|word| !previous.any(|old| old == word))
}

pub(super) fn added_markdown(before: &str, after: &str) -> bool {
    before != after && added_text(&readable(before), &readable(after))
}

pub(super) fn wrote_body(tool: &str, args: &Map<String, Value>, before: &str, after: &str) -> bool {
    let authored = match tool {
        "orion_append_to_note" | "orion_create_tickets" => true,
        "orion_edit_note_text" => args
            .get("new_text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty()),
        "orion_update_ticket" => args.contains_key("implementation_summary"),
        "orion_apply_note_command" => match args.get("command").and_then(Value::as_str) {
            Some(
                "text" | "heading" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "todo" | "bullet"
                | "numbered" | "quote" | "code" | "table" | "table_edit" | "block",
            ) => true,
            Some("link") => args.contains_key("text"),
            Some("image") => args.contains_key("alt"),
            Some("image_layout") => args
                .get("layout")
                .and_then(|value| value.get("caption"))
                .is_some(),
            _ => false,
        },
        _ => false,
    };
    authored && added_markdown(before, after)
}
