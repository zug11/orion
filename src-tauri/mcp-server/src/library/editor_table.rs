//! Version-guarded transformations of standalone portable GFM tables.
//! Cells retain their raw Markdown; only newly supplied text is escaped.
use super::editor::{exact_index, inline, invalid};
use super::*;

const PREFIX: &str = "<!-- orion-table:v1 ";
const MAX_COLUMNS: usize = 100;

pub(super) fn layout_schema() -> Value {
    object(
        json!({
            "width":{"type":"integer","minimum":35,"maximum":100,"description":"Percentage. Changing width scales existing measured columns like the editor unless columns is explicitly supplied."},
            "header":{"type":"boolean"}, "banded":{"type":"boolean"},
            "columns":{"type":"array","maxItems":100,"items":{"anyOf":[{"type":"integer","minimum":48,"maximum":2000},{"type":"null"}]},"description":"One entry per column; null resets a measured width. Omission preserves widths except for width-only proportional resizing."}
        }),
        &[],
    )
}

#[derive(Clone, PartialEq, Eq)]
struct Row {
    cells: Vec<String>,
    leading: String,
    trailing: String,
}
impl Row {
    fn empty(count: usize) -> Self {
        Self {
            cells: vec![" ".into(); count],
            leading: "|".into(),
            trailing: "|".into(),
        }
    }
    fn render(&self) -> String {
        // Moving/removing columns can expose a former cell's heading/list marker
        // at line start. Outer pipes keep all preserved cell bytes inside a table.
        let leading = if self.leading.is_empty() {
            "|"
        } else {
            &self.leading
        };
        let trailing = if self.trailing.is_empty() {
            "|"
        } else {
            &self.trailing
        };
        format!("{}{}{}", leading, self.cells.join("|"), trailing)
    }
}

// Follow Tiptap's pipe preprocessing: balanced inline-code runs protect pipes,
// and ordinary backslash escapes are literal. Preserve the original bytes.
fn row(line: &str) -> Result<Row, ToolFailure> {
    if line.is_empty() || line.starts_with([' ', '\t', '>']) {
        return Err(invalid("Use a complete standalone, unindented GFM table; nested or indented tables need an exact text edit."));
    }
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let heading = (1..=6).contains(&hashes) && line[hashes..].starts_with([' ', '\t']);
    let bullet = line.starts_with(['-', '+', '*']) && line[1..].starts_with([' ', '\t']);
    let ordered = (1..=9).contains(&digits)
        && line[digits..].starts_with(['.', ')'])
        && line[digits + 1..].starts_with([' ', '\t']);
    if heading
        || bullet
        || ordered
        || line.starts_with('<')
        || line.starts_with("```")
        || line.starts_with("~~~")
        || (line.starts_with('[') && line.contains("]:"))
    {
        return Err(invalid("A selected row begins another Markdown block rather than table content. Use explicit outer pipes for such cell text."));
    }
    let bytes = line.as_bytes();
    let mut separators = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i = (i + 2).min(bytes.len());
            continue;
        }
        if bytes[i] == b'`' {
            let count = bytes[i..].iter().take_while(|byte| **byte == b'`').count();
            let mut close = i + count;
            let mut found = None;
            while close < bytes.len() {
                if bytes[close] != b'`' {
                    close += 1;
                    continue;
                }
                let width = bytes[close..]
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                if width == count {
                    found = Some(close + width);
                    break;
                }
                close += width;
            }
            if let Some(end) = found {
                i = end;
                continue;
            }
            i += count;
            continue;
        }
        if bytes[i] == b'|' {
            separators.push(i);
        }
        i += 1;
    }
    if separators.is_empty() {
        return Err(invalid(
            "Every selected table row must have explicit pipe separators.",
        ));
    }
    let mut start = 0;
    let mut end = line.len();
    let mut leading = String::new();
    let mut trailing = String::new();
    if separators.first() == Some(&0) {
        start = 1;
        leading = "|".into();
        separators.remove(0);
    }
    if separators
        .last()
        .is_some_and(|index| line[index + 1..].trim().is_empty())
    {
        end = separators.pop().unwrap();
        trailing = line[end..].into();
    }
    let mut cells = Vec::new();
    for next in separators {
        if next < start || next > end {
            continue;
        }
        cells.push(line[start..next].into());
        start = next + 1;
    }
    cells.push(line[start..end].into());
    if cells.len() > MAX_COLUMNS {
        return Err(invalid(
            "Portable table layout supports at most 100 columns. Nothing is truncated.",
        ));
    }
    Ok(Row {
        cells,
        leading,
        trailing,
    })
}

fn boundary(line: &str) -> bool {
    line.trim().is_empty() || matches!(line, "<!-- orion-block:v1 -->" | "<!-- /orion-block -->")
}

struct Table {
    from: usize,
    to: usize,
    rows: Vec<Row>,
    divider: Row,
    metadata: Map<String, Value>,
    newline: String,
}
impl Table {
    fn parse(body: &str, anchor: &str) -> Result<Self, ToolFailure> {
        let from = exact_index(body, anchor)?;
        let to = from + anchor.len();
        let lines = text::lines(body);
        let first=lines.iter().position(|line|line.byte==from).ok_or_else(||invalid("The table anchor must start at its complete line, including adjacent layout metadata."))?;
        let last = lines
            .iter()
            .position(|line| line.byte + line.text.len() == to)
            .ok_or_else(|| invalid("The table anchor must end at its complete final row."))?;
        if last < first
            || (first > 0 && !boundary(lines[first - 1].text))
            || (last + 1 < lines.len() && !boundary(lines[last + 1].text))
            || super::editor_layout::safe_lines(body)[first..=last]
                .iter()
                .any(|safe| !*safe)
        {
            return Err(invalid("Select the complete standalone table and its adjacent metadata, outside code, frontmatter, HTML and structural continuations."));
        }
        // Even a blank separator does not detach an immediately preceding marker.
        if first >= 2
            && lines[first - 1].text.trim().is_empty()
            && lines[first - 2].text.starts_with("<!-- orion-table:")
        {
            return Err(invalid(
                "Include the table's adjacent metadata in its exact anchor.",
            ));
        }
        let mut selected = lines[first..=last]
            .iter()
            .map(|line| line.text)
            .collect::<Vec<_>>();
        let mut metadata = Map::new();
        if selected
            .first()
            .is_some_and(|line| line.starts_with("<!-- orion-table:"))
        {
            let raw = selected.remove(0);
            let json=raw.strip_prefix(PREFIX).and_then(|s|s.strip_suffix(" -->")).ok_or_else(||invalid("Unknown or malformed table metadata must be preserved with an exact text edit."))?;
            if json.encode_utf16().count() > 1600 {
                return Err(invalid(
                    "Table metadata exceeds its 1,600-character portable limit.",
                ));
            }
            metadata = serde_json::from_str::<Value>(json)
                .ok()
                .and_then(|v| v.as_object().cloned())
                .ok_or_else(|| invalid("Table metadata must be a JSON object."))?;
            if selected.first().is_some_and(|line| line.trim().is_empty()) {
                selected.remove(0);
            }
        }
        if selected.len() < 2 {
            return Err(invalid(
                "A GFM table needs a complete first row and separator row.",
            ));
        }
        let mut rows = selected
            .iter()
            .map(|line| row(line))
            .collect::<Result<Vec<_>, _>>()?;
        let divider = rows.remove(1);
        let columns = divider.cells.len();
        if divider.cells.iter().any(|cell| {
            let value = cell.trim();
            let value = value.strip_prefix(':').unwrap_or(value);
            let value = value.strip_suffix(':').unwrap_or(value);
            value.is_empty() || !value.bytes().all(|b| b == b'-')
        }) || rows.iter().any(|row| row.cells.len() != columns)
        {
            return Err(invalid("The selected table must be rectangular, with a valid GFM separator row. No missing or extra cells are discarded."));
        }
        let defaults = json!({"width":100,"header":true,"banded":true,"columns":[]});
        for (key, value) in defaults.as_object().unwrap() {
            metadata.entry(key).or_insert_with(|| value.clone());
        }
        let known: Map<_, _> = defaults
            .as_object()
            .unwrap()
            .keys()
            .map(|key| (key.clone(), metadata[key].clone()))
            .collect();
        validate_value(
            &Value::Object(known),
            &layout_schema(),
            "existing table layout",
        )?;
        let widths = metadata["columns"].as_array_mut().unwrap();
        if widths.len() > columns {
            return Err(invalid(
                "Existing column-width metadata exceeds the table's real column count.",
            ));
        }
        widths.resize(columns, Value::Null);
        if metadata["header"] == false && rows[0].cells.iter().all(|cell| cell.trim().is_empty()) {
            rows.remove(0);
        }
        if rows.is_empty() {
            return Err(invalid("A table must contain at least one real row."));
        }
        Ok(Self {
            from,
            to,
            rows,
            divider,
            metadata,
            newline: if anchor.contains("\r\n") {
                "\r\n".into()
            } else {
                "\n".into()
            },
        })
    }
    fn columns(&self) -> usize {
        self.divider.cells.len()
    }
    fn render(&self) -> Result<String, ToolFailure> {
        let mut lines = Vec::new();
        let defaults = self.metadata.len() == 4
            && self.metadata["width"] == 100
            && self.metadata["header"] == true
            && self.metadata["banded"] == true
            && self.metadata["columns"]
                .as_array()
                .unwrap()
                .iter()
                .all(Value::is_null);
        if !defaults {
            // Unknown JSON string values must never terminate an HTML comment.
            let encoded = Value::Object(self.metadata.clone())
                .to_string()
                .replace('<', "\\u003c")
                .replace('>', "\\u003e");
            if encoded.encode_utf16().count() > 1600 {
                return Err(invalid(
                    "Updated table metadata exceeds its 1,600-character portable limit.",
                ));
            }
            lines.push(format!("{PREFIX}{encoded} -->"));
        }
        let header = self.metadata["header"] == true;
        lines.push(if header {
            self.rows[0].render()
        } else {
            Row::empty(self.columns()).render()
        });
        lines.push(self.divider.render());
        lines.extend(self.rows.iter().skip(usize::from(header)).map(Row::render));
        Ok(lines.join(&self.newline))
    }
    fn apply_layout(&mut self, changes: &Map<String, Value>) -> Result<(), ToolFailure> {
        if changes.is_empty() {
            return Err(invalid("Provide at least one table layout field."));
        }
        if let Some(columns) = changes.get("columns").and_then(Value::as_array) {
            if columns.len() != self.columns() {
                return Err(invalid(
                    "Supply exactly one width or null for every logical table column.",
                ));
            }
        }
        if let Some(width) = changes.get("width").and_then(Value::as_u64) {
            let previous = self.metadata["width"].as_u64().unwrap();
            if width != previous && !changes.contains_key("columns") {
                for column in self.metadata["columns"].as_array_mut().unwrap() {
                    if let Some(value) = column.as_u64() {
                        *column = json!(((value as f64 * width as f64 / previous as f64).round()
                            as u64)
                            .clamp(64, 2000));
                    }
                }
            }
        }
        self.metadata.extend(changes.clone());
        Ok(())
    }
    fn edit(&mut self, args: &Map<String, Value>) -> Result<bool, ToolFailure> {
        let operation = arg(args, "operation");
        let row_count = self.rows.len();
        let column_count = self.columns();
        let index = |key: &str, max: usize, insert: bool| -> Result<usize, ToolFailure> {
            let value = args
                .get(key)
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid(&format!("{operation} requires {key}.")))?
                as usize;
            if value > max || (!insert && value == max) {
                Err(invalid(
                    "The requested table index is outside its logical dimensions.",
                ))
            } else {
                Ok(value)
            }
        };
        let values = |count: usize| -> Result<Vec<String>, ToolFailure> {
            match args.get("values").and_then(Value::as_array) {
                None => Ok(vec![" ".into(); count]),
                Some(values) if values.len() == count => Ok(values
                    .iter()
                    .map(|value| literal_cell(value.as_str().unwrap()))
                    .collect()),
                _ => Err(invalid(
                    "Inserted values must match the table's opposite dimension exactly.",
                )),
            }
        };
        match operation {
            "delete" => return Ok(true),
            "insert_row" => {
                let at = index("row_index", row_count, true)?;
                if row_count >= 20 {
                    return Err(invalid("New rows are limited to 20. Existing larger imported tables remain intact."));
                }
                let cells = values(column_count)?;
                self.rows.insert(
                    at,
                    Row {
                        cells,
                        leading: "|".into(),
                        trailing: "|".into(),
                    },
                );
            }
            "delete_row" => {
                let at = index("row_index", row_count, false)?;
                if row_count == 1 {
                    return Ok(true);
                }
                self.rows.remove(at);
            }
            "insert_column" => {
                let at = index("column_index", column_count, true)?;
                if column_count >= 12 {
                    return Err(invalid("New columns are limited to 12. Existing larger imported tables remain intact."));
                }
                let cells = values(row_count)?;
                for (row, cell) in self.rows.iter_mut().zip(cells) {
                    row.cells.insert(at, cell);
                }
                self.divider.cells.insert(at, " --- ".into());
                self.metadata["columns"]
                    .as_array_mut()
                    .unwrap()
                    .insert(at, Value::Null);
            }
            "delete_column" => {
                let at = index("column_index", column_count, false)?;
                if column_count == 1 {
                    return Ok(true);
                }
                for row in &mut self.rows {
                    row.cells.remove(at);
                }
                self.divider.cells.remove(at);
                self.metadata["columns"].as_array_mut().unwrap().remove(at);
            }
            "set_cell" => {
                let r = index("row_index", row_count, false)?;
                let c = index("column_index", column_count, false)?;
                let value = args.get("text").and_then(Value::as_str).ok_or_else(|| {
                    invalid("set_cell requires literal text; an empty string clears the cell.")
                })?;
                if value.chars().count() > 2000 {
                    return Err(invalid(
                        "A replacement cell is limited to 2,000 characters.",
                    ));
                }
                self.rows[r].cells[c] = literal_cell(value);
            }
            "resize" => {
                if !args.contains_key("row_count") && !args.contains_key("column_count") {
                    return Err(invalid("Resize requires row_count or column_count."));
                }
                let rows = args
                    .get("row_count")
                    .and_then(Value::as_u64)
                    .map_or(row_count, |v| v as usize);
                let columns = args
                    .get("column_count")
                    .and_then(Value::as_u64)
                    .map_or(column_count, |v| v as usize);
                if rows > row_count.max(20) || columns > column_count.max(12) {
                    return Err(invalid("Resize cannot grow beyond 20 rows or 12 columns, or the table's existing larger dimensions. Nothing is clamped."));
                }
                if args.get("allow_content_removal") != Some(&Value::Bool(true))
                    && self.rows.iter().enumerate().any(|(r, row)| {
                        row.cells
                            .iter()
                            .enumerate()
                            .any(|(c, cell)| (r >= rows || c >= columns) && !cell.trim().is_empty())
                    })
                {
                    return Err(invalid("Resize would remove nonempty cells. Reissue with allow_content_removal:true only when that removal is intended."));
                }
                self.rows.truncate(rows);
                self.rows.resize_with(rows, || Row::empty(column_count));
                for row in &mut self.rows {
                    row.cells.resize(columns, " ".into());
                }
                self.divider.cells.resize(columns, " --- ".into());
                self.metadata["columns"]
                    .as_array_mut()
                    .unwrap()
                    .resize(columns, Value::Null);
            }
            _ => return Err(invalid("Provide a documented table operation.")),
        }
        Ok(false)
    }
}

fn literal_cell(value: &str) -> String {
    format!(
        " {} ",
        inline(value)
            .replace("\r\n", "\n")
            .replace(['\r', '\n'], "<br>")
    )
}

pub(super) fn apply(current: &Note, args: &Map<String, Value>) -> Result<String, ToolFailure> {
    let specific: &[&str] = if arg(args, "command") == "table_layout" {
        &["table_layout"]
    } else {
        match arg(args, "operation") {
            "insert_row" => &["operation", "row_index", "values"],
            "delete_row" => &["operation", "row_index"],
            "insert_column" => &["operation", "column_index", "values"],
            "delete_column" => &["operation", "column_index"],
            "set_cell" => &["operation", "row_index", "column_index", "text"],
            "resize" => &[
                "operation",
                "row_count",
                "column_count",
                "allow_content_removal",
            ],
            "delete" => &["operation"],
            _ => return Err(invalid("Provide a documented table operation.")),
        }
    };
    if args.keys().any(|key| {
        ![
            "space_id",
            "note_id",
            "expected_version",
            "command",
            "anchor",
        ]
        .contains(&key.as_str())
            && !specific.contains(&key.as_str())
    }) {
        return Err(invalid("This table operation accepts only its documented fields, not insertion placement or unrelated replacement content."));
    }
    let mut table = Table::parse(&current.body, arg(args, "anchor"))?;
    let before = (
        table.rows.clone(),
        table.divider.clone(),
        table.metadata.clone(),
    );
    let remove = if arg(args, "command") == "table_layout" {
        let layout = args
            .get("table_layout")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("Provide a partial table_layout object."))?;
        table.apply_layout(layout)?;
        false
    } else {
        table.edit(args)?
    };
    if !remove
        && (
            table.rows.clone(),
            table.divider.clone(),
            table.metadata.clone(),
        ) == before
    {
        return Ok(current.body.clone());
    }
    let replacement = if remove {
        String::new()
    } else {
        table.render()?
    };
    Ok(format!(
        "{}{}{}",
        &current.body[..table.from],
        replacement,
        &current.body[table.to..]
    ))
}
