//! Passage discussions are metadata only. Prose changes remain desktop reviews.
use super::*;

pub(super) fn fields() -> Value {
    json!({"note_id":string(200),"expected_version":string(100),"thread_id":string(200),"message_id":string(200),
      "quote":string(12000),"comment":string(12000),
      "proposal":object(json!({"kind":{"type":"string","enum":["addition","rewrite"]},"text":string(12000)}), &["kind","text"])})
}
fn valid_text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max)
}
pub(crate) fn valid(threads: &[Value]) -> bool {
    let mut ids = BTreeSet::new();
    threads.len() <= 32
        && threads.iter().all(|t| {
            let mut messages = BTreeSet::new();
            valid_text(&t["id"], 200)
                && ids.insert(t["id"].as_str().unwrap())
                && (if t["anchor"]["scope"] == "note" {
                    t["anchor"]["quote"] == "" && t["anchor"]["text"] == ""
                } else {
                    t["anchor"].get("scope").is_none()
                        && valid_text(&t["anchor"]["quote"], 12000)
                        && valid_text(&t["anchor"]["text"], 12000)
                })
                && (t["anchor"].get("cursor").is_none()
                    || ["before", "after"].iter().all(|field| {
                        t["anchor"]["cursor"][field]
                            .as_str()
                            .is_some_and(|text| text.encode_utf16().count() <= 256)
                    }))
                && matches!(t["state"].as_str(), Some("proposed" | "open" | "resolved"))
                && valid_text(&t["createdAt"], 80)
                && valid_text(&t["updatedAt"], 80)
                && t["messages"].as_array().is_some_and(|list| {
                    !list.is_empty()
                        && list.len() <= 30
                        && list.iter().all(|m| {
                            valid_text(&m["id"], 200)
                                && messages.insert(m["id"].as_str().unwrap())
                                && matches!(m["role"].as_str(), Some("assistant" | "user"))
                                && (m.get("pending").is_none() || m["pending"].is_boolean())
                                && (m.get("createdNoteId").is_none()
                                    || valid_text(&m["createdNoteId"], 200))
                                && valid_text(&m["content"], 12000)
                                && valid_text(&m["createdAt"], 80)
                                && (m.get("proposal").is_none()
                                    || matches!(
                                        m["proposal"]["kind"].as_str(),
                                        Some("addition" | "rewrite")
                                    ) && valid_text(&m["proposal"]["text"], 12000))
                        })
                })
        })
}
fn unique(body: &str, quote: &str) -> bool {
    !quote.trim().is_empty()
        && body
            .char_indices()
            .filter(|(at, _)| body[*at..].starts_with(quote))
            .take(2)
            .count()
            == 1
}
fn rendered(markdown: &str) -> String {
    use pulldown_cmark::{Event, Parser, TagEnd};
    let mut text = String::new();
    for event in Parser::new(markdown) {
        match event {
            Event::Text(value) | Event::Code(value) => text.push_str(&value),
            Event::SoftBreak
            | Event::HardBreak
            | Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::TableRow,
            ) => text.push(' '),
            _ => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
pub(super) fn propose(current: &Note, args: &Map<String, Value>) -> Result<Value, ToolFailure> {
    let quote = arg(args, "quote");
    if !unique(&working_view::mask(&current.body), quote) || quote.contains("<!--") {
        return Err(ToolFailure::new("Supply an exact unique visible authored passage. Completed tasks and metadata cannot receive agent comments."));
    }
    let id = arg(args, "thread_id");
    let mut threads = current.discussion_threads.clone();
    let now = now_iso()?;
    let mut message = json!({"id":arg(args,"message_id"),"role":"assistant","pending":true,"content":arg(args,"comment"),"createdAt":now});
    if let Some(proposal) = args.get("proposal") {
        message["proposal"] = proposal.clone();
    }
    if let Some(thread) = threads.iter_mut().find(|t| t["id"] == id) {
        if thread["anchor"]["quote"] != quote {
            return Err(ToolFailure::new(
                "A thread cannot be retargeted by an agent.",
            ));
        }
        let messages = thread["messages"].as_array_mut().unwrap();
        if messages.iter().any(|m| m["id"] == message["id"]) {
            return Err(ToolFailure::new(
                "This message ID is already present. Read the thread before retrying.",
            ));
        }
        messages.push(message);
        thread["updatedAt"] = json!(now);
        thread["state"] = json!("proposed");
    } else {
        threads.push(json!({"id":id,"anchor":{"quote":quote,"text":rendered(quote)},"state":"proposed","messages":[message],"createdAt":now,"updatedAt":now}));
    }
    if !valid(&threads) {
        return Err(ToolFailure::new(
            "The proposed comment exceeds the thread, message or UTF-16 text limit.",
        ));
    }
    Ok(json!(threads))
}
pub(super) fn read(scope: &Space, args: &Map<String, Value>) -> ToolResult {
    let note = note(scope, arg(args, "note_id"))?;
    expected(args, &note_version(note))?;
    let history = working_view::history(args)?;
    // A working view marks versions before masking. Historical discussion can
    // paraphrase completed tasks, so conservatively omit it from filtered reads.
    let hidden = !history && note.view_version.is_some();
    let offset = number(args, "offset", 0);
    let limit = number(args, "limit", 4);
    let message_offset = number(args, "message_offset", 0);
    let max_messages = number(args, "max_messages", 4);
    let total = if hidden {
        0
    } else {
        note.discussion_threads.len()
    };
    let threads: Vec<_> = if hidden {
        vec![]
    } else {
        note.discussion_threads
            .iter()
            .skip(offset)
            .take(limit)
            .map(|thread| {
                let mut value = thread.clone();
                let messages = thread["messages"].as_array().unwrap();
                value["messages"] = json!(messages
                    .iter()
                    .skip(message_offset)
                    .take(max_messages)
                    .collect::<Vec<_>>());
                value["totalMessages"] = json!(messages.len());
                value["nextMessageOffset"] =
                    json!(if message_offset + max_messages < messages.len() {
                        Some(message_offset + max_messages)
                    } else {
                        None
                    });
                value["anchorCurrent"] = json!(
                    thread["anchor"]["scope"] == "note"
                        || unique(&note.body, thread["anchor"]["quote"].as_str().unwrap_or(""))
                );
                value
            })
            .collect()
    };
    Ok(
        json!({"note":citation(scope,note),"threads":threads,"discussionOmitted":hidden,"offset":offset,"total":total,"nextOffset":if offset+limit<total {Some(offset+limit)}else{None}}),
    )
}
