use super::*;

#[derive(Debug)]
pub(super) struct Line<'a> {
    pub index: usize,
    pub byte: usize,
    pub text: &'a str,
    pub visible: bool,
}

pub(super) fn lines(body: &str) -> Vec<Line<'_>> {
    let raw: Vec<_> = body.split_inclusive('\n').collect();
    let frontmatter = if raw.first().is_some_and(|line| line.trim_end() == "---") {
        raw.iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| matches!(line.trim_end(), "---" | "..."))
            .map(|(index, _)| index)
    } else {
        None
    };
    let mut byte = 0;
    let mut fence: Option<(char, usize)> = None;
    raw.iter()
        .enumerate()
        .map(|(index, line)| {
            let text = line.trim_end_matches(['\r', '\n']);
            let trimmed = text.trim_start();
            let indent = text.len() - trimmed.len();
            let mut visible = frontmatter.is_none_or(|end| index > end);
            if visible && indent <= 3 {
                let marker = trimmed.chars().next().unwrap_or(' ');
                let width = trimmed.chars().take_while(|value| *value == marker).count();
                if let Some((open, count)) = fence {
                    visible = false;
                    if marker == open && width >= count && trimmed[width..].trim().is_empty() {
                        fence = None;
                    }
                } else if matches!(marker, '`' | '~')
                    && width >= 3
                    && !(marker == '`' && trimmed[width..].contains('`'))
                {
                    fence = Some((marker, width));
                    visible = false;
                }
            } else if fence.is_some() {
                visible = false;
            }
            let result = Line {
                index,
                byte,
                text,
                visible,
            };
            byte += line.len();
            result
        })
        .collect()
}

#[derive(Debug)]
pub(super) struct Section {
    pub title: String,
    pub level: usize,
    pub start: usize,
    pub end: usize,
}
pub(super) fn sections(body: &str) -> Vec<Section> {
    let lines = lines(body);
    let mut headings = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !line.visible {
            continue;
        }
        let trimmed = line.text.trim_start();
        if line.text.len() - trimmed.len() > 3 {
            continue;
        }
        let level = trimmed.bytes().take_while(|byte| *byte == b'#').count();
        if (1..=6).contains(&level) && trimmed[level..].starts_with([' ', '\t']) {
            let mut title = trimmed[level..].trim();
            let without_hashes = title.trim_end_matches('#');
            if without_hashes.ends_with([' ', '\t']) {
                title = without_hashes.trim_end();
            }
            if !title.is_empty() {
                headings.push(Section {
                    title: plain(title),
                    level,
                    start: line.byte,
                    end: body.len(),
                });
            }
        } else if index > 0
            && !trimmed.is_empty()
            && (trimmed.chars().all(|c| c == '=') || trimmed.chars().all(|c| c == '-'))
        {
            let previous = &lines[index - 1];
            if previous.visible
                && !previous.text.trim().is_empty()
                && !previous
                    .text
                    .trim_start()
                    .starts_with(['#', '-', '*', '+', '>'])
                && !headings
                    .iter()
                    .any(|heading| heading.start == previous.byte)
            {
                headings.push(Section {
                    title: plain(previous.text.trim()),
                    level: if trimmed.starts_with('=') { 1 } else { 2 },
                    start: previous.byte,
                    end: body.len(),
                });
            }
        }
    }
    for index in 0..headings.len() {
        if let Some(next) = headings
            .iter()
            .skip(index + 1)
            .find(|next| next.level <= headings[index].level)
        {
            headings[index].end = next.start;
        }
    }
    headings
}

#[derive(Debug)]
pub(super) struct Task {
    pub line: usize,
    pub marker_byte: usize,
    pub raw: String,
    pub checked: bool,
}
pub(super) fn tasks(body: &str) -> Vec<Task> {
    lines(body)
        .into_iter()
        .filter_map(|line| {
            if !line.visible {
                return None;
            }
            let trimmed = line.text.trim_start();
            let lead = line.text.len() - trimmed.len();
            if !trimmed.starts_with(['-', '+', '*']) {
                return None;
            }
            let after = &trimmed[1..];
            if !after.starts_with([' ', '\t']) {
                return None;
            }
            let checkbox = after.trim_start_matches([' ', '\t']);
            let bytes = checkbox.as_bytes();
            if bytes.len() < 5
                || bytes[0] != b'['
                || !matches!(bytes[1], b' ' | b'x' | b'X')
                || bytes[2] != b']'
                || !matches!(bytes[3], b' ' | b'\t')
            {
                return None;
            }
            let raw = checkbox[3..].trim();
            if raw.is_empty() {
                return None;
            }
            Some(Task {
                line: line.index,
                marker_byte: line.byte + lead + 1 + (after.len() - checkbox.len()) + 1,
                raw: raw.into(),
                checked: bytes[1] != b' ',
            })
        })
        .collect()
}

// Readable labels only, never a Markdown-to-HTML renderer.
pub(super) fn plain(value: &str) -> String {
    let mut output = String::new();
    let mut remaining = value;
    while !remaining.is_empty() {
        if remaining.starts_with("![") {
            remaining = &remaining[1..];
            continue;
        }
        if remaining.starts_with('[') {
            if let Some(end) = remaining.find("](") {
                if let Some(close) = remaining[end + 2..].find(')') {
                    output.push_str(&remaining[1..end]);
                    remaining = &remaining[end + 3 + close..];
                    continue;
                }
            }
        }
        if remaining.starts_with('<') {
            if let Some(end) = remaining.find('>') {
                output.push(' ');
                remaining = &remaining[end + 1..];
                continue;
            }
        }
        let ch = remaining.chars().next().unwrap();
        remaining = &remaining[ch.len_utf8()..];
        if !matches!(ch, '`' | '*' | '_' | '~') {
            output.push(ch);
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn task_concept<'a>(scope: &'a Space, note: &Note, raw: &str) -> Option<&'a Concept> {
    for concept in &scope.concepts {
        if raw.contains(&format!("orion-concept://{})", concept.id))
            || concept
                .canonical_note_id
                .as_ref()
                .is_some_and(|id| raw.contains(&format!("orion-note://{id})")))
        {
            return Some(concept);
        }
    }
    let text = format!(" {} ", normalize_link_query(&plain(raw)));
    let best = scope
        .concepts
        .iter()
        .filter(|c| c.auto_link)
        .flat_map(|concept| {
            std::iter::once(&concept.label)
                .chain(concept.aliases.iter())
                .map(move |label| (concept, label))
        })
        .filter(|(_, label)| {
            !label.is_empty() && text.contains(&format!(" {} ", normalize_link_query(label)))
        })
        .max_by_key(|(_, label)| label.chars().count())
        .map(|(concept, _)| concept);
    if best.is_some() {
        return best;
    }
    let candidates: Vec<_> = scope
        .concepts
        .iter()
        .filter(|concept| note.concept_ids.contains(&concept.id))
        .collect();
    candidates
        .iter()
        .find(|concept| concept.canonical_note_id.as_deref() == Some(&note.id))
        .copied()
        .or_else(|| {
            if candidates.len() == 1 {
                Some(candidates[0])
            } else {
                None
            }
        })
}
