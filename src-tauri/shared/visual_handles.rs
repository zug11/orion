use super::{fields, invalid, js_space, list, literal, number, Value};
use std::collections::HashSet;

type Point = (f64, f64);
const ZERO: Point = (0., 0.);

fn pair(value: &Value, min: Point, max: Point) -> Result<Point, String> {
    let p = list(value, 2, 2)?;
    Ok((number(&p[0], min.0, max.0)?, number(&p[1], min.1, max.1)?))
}

fn track(t: &Value, size: Point) -> Result<(), String> {
    let from = pair(&t["from"], ZERO, size)?;
    if let Some(to) = t.get("to") {
        fields(t, &["from", "to"])?;
        let to = pair(to, ZERO, size)?;
        if (from.0 - to.0).hypot(from.1 - to.1) < 4. {
            return Err(invalid("drawing handle track is too short"));
        }
    } else {
        fields(t, &["from", "pivot", "turn"])?;
        let pivot = pair(&t["pivot"], ZERO, size)?;
        let turn = number(&t["turn"], -330., 330.)?;
        let dx = from.0 - pivot.0;
        let dy = from.1 - pivot.1;
        let radius = dx.hypot(dy);
        if radius < 4. || turn.abs() < 5. {
            return Err(invalid("drawing handle arc is too short"));
        }
        let start = dy.atan2(dx).to_degrees();
        let end = start + turn;
        let inside = |angle: f64| {
            let (sin, cos) = angle.to_radians().sin_cos();
            let (x, y) = (pivot.0 + radius * cos, pivot.1 + radius * sin);
            (-1e-8..=size.0 + 1e-8).contains(&x) && (-1e-8..=size.1 + 1e-8).contains(&y)
        };
        let low = (start.min(end) / 90.).ceil() as i32;
        let high = (start.max(end) / 90.).floor() as i32;
        if !inside(end) || (low..=high).any(|k| !inside(f64::from(k) * 90.)) {
            return Err(invalid("drawing handle arc leaves the canvas"));
        }
    }
    Ok(())
}

pub(super) fn validate(
    drawing: &Value,
    size: Point,
    passage: &str,
    ids: &HashSet<&str>,
    level_parts: &HashSet<&str>,
) -> Result<(), String> {
    let mut labels = HashSet::new();
    let mut rotations = HashSet::new();
    if let Some(handles) = drawing.get("handles") {
        for handle in list(handles, 1, 4)? {
            fields(
                handle,
                &["label", "ends", "quote", "track", "initial", "effects"],
            )?;
            if !labels.insert(literal(&handle["label"], 80, false)?.trim_matches(js_space))
                || !passage.contains(literal(&handle["quote"], 400, false)?)
            {
                return Err(invalid(
                    "drawing handles need distinct labels and a verbatim source quote",
                ));
            }
            let ends = list(&handle["ends"], 2, 2)?;
            if literal(&ends[0], 64, false)?.trim_matches(js_space)
                == literal(&ends[1], 64, false)?.trim_matches(js_space)
            {
                return Err(invalid(
                    "drawing handle endpoints must have different labels",
                ));
            }
            track(&handle["track"], size)?;
            if let Some(initial) = handle.get("initial") {
                number(initial, 0., 1.)?;
            }
            effects(&handle["effects"], size, ids, level_parts, &mut rotations)?;
        }
    }
    if let Some(animation) = drawing.get("animation") {
        fields(animation, &["label", "quote", "duration", "loop", "tracks"])?;
        literal(&animation["label"], 80, false)?;
        if !passage.contains(literal(&animation["quote"], 400, false)?) {
            return Err(invalid("animation quote missing from passage"));
        }
        let duration = number(&animation["duration"], 0.5, 60.)?;
        let looping = animation
            .get("loop")
            .map(|v| {
                v.as_bool()
                    .ok_or_else(|| invalid("expected a boolean loop"))
            })
            .transpose()?
            .unwrap_or(false);
        let mut driven = HashSet::new();
        for t in list(&animation["tracks"], 1, 8)? {
            fields(t, &["keys", "effects", "handle"])?;
            let keys = list(&t["keys"], 2, 32)?
                .iter()
                .map(|v| pair(v, ZERO, (duration, 1.)))
                .collect::<Result<Vec<_>, _>>()?;
            let first = keys[0];
            let last = keys[keys.len() - 1];
            let full_turns = if let Some(index) = t.get("handle") {
                fields(t, &["keys", "handle"])?;
                let handles = list(&drawing["handles"], 1, 4)?;
                let index = number(index, 0., (handles.len() - 1) as f64)?;
                if index.fract() != 0.
                    || !driven.insert(index as usize)
                    || first.1 != handles[index as usize]["initial"].as_f64().unwrap_or(0.)
                    || !keys.iter().any(|k| k.1 == 0.)
                    || !keys.iter().any(|k| k.1 == 1.)
                {
                    return Err(invalid("a driven handle needs one track from its initial position covering its full travel"));
                }
                false
            } else {
                effects(&t["effects"], size, ids, level_parts, &mut rotations)?;
                list(&t["effects"], 1, 12)?.iter().all(|effect| {
                    effect["turn"].as_f64().is_some_and(|degrees| {
                        let turns = degrees * (last.1 - first.1) / 360.;
                        (turns - turns.round()).abs() < 1e-9
                    })
                })
            };
            if first.0 != 0.
                || last.0 != duration
                || keys.windows(2).any(|w| w[0].0 >= w[1].0)
                || keys.iter().all(|k| k.1 == first.1)
                || (looping && first.1 != last.1 && !full_turns)
            {
                return Err(invalid(
                    "invalid animation keyframe coverage, order, change or loop seam",
                ));
            }
        }
    }
    Ok(())
}

fn effects<'a>(
    items: &'a Value,
    size: Point,
    ids: &HashSet<&str>,
    level_parts: &HashSet<&str>,
    rotations: &mut HashSet<&'a str>,
) -> Result<(), String> {
    let mut owners = HashSet::new();
    for e in list(items, 1, 12)? {
        let key = if e.get("move").is_some() {
            fields(e, &["parts", "move"])?;
            if pair(&e["move"], (-size.0, -size.1), size)? == ZERO {
                return Err(invalid("a drawing handle movement cannot be zero"));
            }
            "move"
        } else if e.get("turn").is_some() {
            fields(e, &["parts", "pivot", "turn"])?;
            pair(&e["pivot"], ZERO, size)?;
            if number(&e["turn"], -720., 720.)? == 0. {
                return Err(invalid("a drawing handle rotation cannot be zero"));
            }
            "turn"
        } else {
            let key = if e.get("level").is_some() {
                "level"
            } else {
                "opacity"
            };
            fields(e, &["parts", key])?;
            let (a, b) = pair(&e[key], ZERO, (1., 1.))?;
            if a == b {
                return Err(invalid("a drawing effect must change its value"));
            }
            key
        };
        let mut seen = HashSet::new();
        for target in list(&e["parts"], 1, 28)? {
            let id = literal(target, 40, false)?;
            if !ids.contains(id)
                || !seen.insert(id)
                || !owners.insert((key, id))
                || (key == "turn" && !rotations.insert(id))
            {
                return Err(invalid(
                    "unknown, duplicate or conflicting drawing handle target",
                ));
            }
            if key == "level" && !level_parts.contains(id) {
                return Err(invalid(
                    "level target needs a responsive glyph or level-painted rectangle",
                ));
            }
        }
    }
    Ok(())
}
