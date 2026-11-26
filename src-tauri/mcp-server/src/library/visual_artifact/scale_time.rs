use super::{fields, illustration, invalid, list, literal, number, optional_text};
use crate::library::{array, object, string};
use serde_json::{json, Value};

const LENGTH_UNITS: &[&str] = &["pm", "nm", "µm", "mm", "cm", "m", "km", "AU", "ly"];
const TIME_UNITS: &[&str] = &["seconds", "minutes", "hours", "days", "years"];

fn named(row: &Value) -> Result<(), String> {
    literal(&row["label"], 80, false)?;
    optional_text(row, "detail", 500)
}

fn unit(row: &Value, allowed: &[&str]) -> Result<(), String> {
    if row["unit"].as_str().is_some_and(|u| allowed.contains(&u)) {
        Ok(())
    } else {
        Err(invalid("unsupported measurement unit"))
    }
}

pub(super) fn validate(block: &Value) -> Result<(), String> {
    match block["kind"].as_str() {
        Some("scaleZoom") => {
            fields(block, &["kind", "items"])?;
            for row in list(&block["items"], 2, 12)? {
                fields(row, &["label", "size", "unit", "detail", "path"])?;
                named(row)?;
                unit(row, LENGTH_UNITS)?;
                number(&row["size"], 1e-60, 1e60)?;
                if let Some(path) = row.get("path") {
                    literal(path, 1200, false)?;
                    illustration::path(path, (100., 100.))?;
                }
            }
        }
        Some("deepTime") => {
            fields(block, &["kind", "duration", "unit", "events"])?;
            unit(block, TIME_UNITS)?;
            let duration = number(&block["duration"], 1e-60, 1e60)?;
            for event in list(&block["events"], 1, 16)? {
                fields(event, &["label", "beforeEnd", "daySecond", "detail"])?;
                named(event)?;
                match (event.get("beforeEnd"), event.get("daySecond")) {
                    (Some(distance), None) => number(distance, 0., duration)?,
                    (None, Some(seconds)) => number(seconds, 0., 86400.)?,
                    _ => return Err(invalid("each event needs either beforeEnd or daySecond")),
                };
            }
        }
        _ => return Err(invalid("unknown scale or time block")),
    }
    Ok(())
}

pub(crate) fn definitions() -> Vec<Value> {
    let size = json!({"type":"number", "minimum":1e-60, "maximum":1e60});
    let item = object(
        json!({
            "label": string(80), "detail": string(500), "size": size, "unit":{"type":"string","enum":LENGTH_UNITS},
            "path": {"type":"string","minLength":1,"maxLength":1200,"description":"Optional silhouette spanning the width of a 100 by 100 square. Use explicit absolute M/L/H/V/Q/C/A/Z commands."}
        }),
        &["label", "size", "unit"],
    );
    let mut event = object(
        json!({
            "label":string(80), "detail":string(500),
            "beforeEnd":{"type":"number","minimum":0,"maximum":1e60,"description":"Time remaining in the declared unit, at most duration."},
            "daySecond":{"type":"number","minimum":0,"maximum":86400,"description":"Use for a clock time already stated in the passage."}
        }),
        &["label"],
    );
    event["oneOf"] = json!([{"required":["beforeEnd"]},{"required":["daySecond"]}]);
    vec![
        object(
            json!({"kind":{"const":"scaleZoom"},"items":array(item, 2, 12)}),
            &["kind", "items"],
        ),
        object(
            json!({"kind":{"const":"deepTime"}, "unit":{"type":"string","enum":TIME_UNITS}, "duration":size, "events":array(event, 1, 16)}),
            &["kind", "unit", "duration", "events"],
        ),
    ]
}
