use super::{fields, invalid, js_space, list, literal, number, Value};
use std::collections::HashSet;

pub(crate) const GLYPHS: &[&str] = &[
    "tank",
    "battery",
    "thermometer",
    "gauge",
    "balance",
    "bar",
    "pie",
    "coins",
    "sun",
    "solar-panel",
    "house",
    "factory",
    "utility-pole",
    "zap",
    "droplets",
    "waves-horizontal",
    "mountain",
    "leaf",
    "sprout",
    "flame",
    "wind",
    "car",
    "bike",
    "train-front",
    "plane",
    "ship",
    "tractor",
    "users",
    "building-2",
    "landmark",
    "store",
    "warehouse",
    "piggy-bank",
    "scale",
    "heart-pulse",
    "cpu",
    "globe",
];
pub(crate) const PAINTS: &[&str] = &[
    "outline", "soft", "fill", "solid", "bold", "heavy", "thin", "dashed", "dotted", "level",
];
pub(crate) const TONES: &[&str] = &["accent", "warm", "cool", "rose", "neutral", "ground"];

type Size = (f64, f64);
fn option<'a>(val: &'a Value, names: &[&str]) -> Result<&'a str, String> {
    val.as_str()
        .filter(|name| names.contains(name))
        .ok_or_else(|| invalid("unknown drawing option"))
}
fn positive(v: &Value, max: f64) -> Result<f64, String> {
    number(v, 0., max).and_then(|n| {
        if n > 0. {
            Ok(n)
        } else {
            Err(invalid("expected positive drawing dimension"))
        }
    })
}
fn boolean(v: &Value) -> Result<bool, String> {
    v.as_bool()
        .ok_or_else(|| invalid("expected a boolean drawing option"))
}

pub(crate) fn path(value: &Value, (width, height): Size) -> Result<(), String> {
    let error =
        || invalid("invalid illustration path; use explicit absolute commands within the canvas");
    let mut input = literal(value, 4000, false)?.trim_matches(js_space);
    let mut groups = 0;
    while !input.is_empty() {
        let op = input.as_bytes()[0];
        let limits: &[f64] = match op {
            b'M' | b'L' => &[width, height],
            b'H' => &[width],
            b'V' => &[height],
            b'C' => &[width, height, width, height, width, height],
            b'Q' => &[width, height, width, height],
            b'A' => &[width, height, 360., 1., 1., width, height],
            b'Z' => &[],
            _ => return Err(error()),
        };
        if groups == 0 && op != b'M' {
            return Err(error());
        }
        groups += 1;
        if groups > 96 {
            return Err(error());
        }
        input = input[1..].trim_start_matches(js_space);
        for (i, max) in limits.iter().enumerate() {
            let bytes = input.as_bytes();
            let sign = usize::from(bytes.first() == Some(&b'-'));
            let whole = bytes[sign..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            let mut end = sign + whole;
            let mut decimals = 0;
            if bytes.get(end) == Some(&b'.') {
                end += 1;
                decimals = bytes[end..]
                    .iter()
                    .take_while(|b| b.is_ascii_digit())
                    .count();
                end += decimals;
            }
            if whole + decimals == 0 {
                return Err(error());
            }
            let token = &input[..end];
            let n = token.parse::<f64>().map_err(|_| error())?;
            let min = if op == b'A' && i == 2 { -360. } else { 0. };
            if !(min..=*max).contains(&n)
                || op == b'A' && (i == 3 || i == 4) && !matches!(token, "0" | "1")
            {
                return Err(error());
            }
            input = &input[end..];
            if input.starts_with('.') {
                return Err(error());
            }
            input = input.trim_start_matches(js_space);
            if input.starts_with(',') {
                input = input[1..].trim_start_matches(js_space);
                if !input.starts_with(|c: char| c.is_ascii_digit() || matches!(c, '.' | '-')) {
                    return Err(error());
                }
            }
        }
    }
    if groups == 0 {
        Err(error())
    } else {
        Ok(())
    }
}

fn shapes(values: &Value, (w, h): Size, total: &mut usize) -> Result<(), String> {
    for v in list(values, 1, 60)? {
        *total += 1;
        if *total > 520 {
            return Err(invalid("too many drawing shapes"));
        }
        let paint = option(&v["paint"], PAINTS)?;
        if paint == "level" && v["type"] != "rect" {
            return Err(invalid("only rectangles can take level paint"));
        }
        let x = |key: &str| number(&v[key], 0., w);
        let y = |key: &str| number(&v[key], 0., h);
        match v["type"].as_str() {
            Some("rect") => {
                fields(v, &["type", "paint", "x", "y", "w", "h", "r"])?;
                let width = positive(&v["w"], w - x("x")?)?;
                let height = positive(&v["h"], h - y("y")?)?;
                if let Some(r) = v.get("r") {
                    number(r, 0., width.min(height) / 2.)?;
                }
            }
            Some(kind @ ("circle" | "ellipse")) => {
                let cx = x("cx")?;
                let cy = y("cy")?;
                let mx = cx.min(w - cx);
                let my = cy.min(h - cy);
                if kind == "circle" {
                    fields(v, &["type", "paint", "cx", "cy", "r"])?;
                    positive(&v["r"], mx.min(my))?;
                } else {
                    fields(v, &["type", "paint", "cx", "cy", "rx", "ry"])?;
                    positive(&v["rx"], mx)?;
                    positive(&v["ry"], my)?;
                }
            }
            Some("line") => {
                fields(v, &["type", "paint", "x1", "y1", "x2", "y2"])?;
                x("x1")?;
                x("x2")?;
                y("y1")?;
                y("y2")?;
            }
            Some(kind @ ("polygon" | "polyline")) => {
                fields(v, &["type", "paint", "points"])?;
                for p in list(&v["points"], if kind == "polygon" { 3 } else { 2 }, 80)? {
                    let pair = list(p, 2, 2)?;
                    number(&pair[0], 0., w)?;
                    number(&pair[1], 0., h)?;
                }
            }
            Some("path") => {
                fields(v, &["type", "paint", "d"])?;
                path(&v["d"], (w, h))?;
            }
            _ => return Err(invalid("unknown drawing shape")),
        }
    }
    Ok(())
}

pub(crate) fn validate(value: &Value) -> Result<(), String> {
    fields(value, &["kind", "view", "passage", "parts", "states"])?;
    if value["kind"] != "illustration" {
        return Err(invalid("expected an illustration block"));
    }
    let dimensions = match value["view"].as_str() {
        Some("landscape") => (640., 400.),
        Some("square") => (480., 480.),
        Some("portrait") => (400., 560.),
        _ => return Err(invalid("unknown illustration view")),
    };
    let passage = literal(&value["passage"], 12000, false)?;
    let mut ids = HashSet::new();
    let mut any_selectable = false;
    let mut total = 0;
    for part in list(&value["parts"], 1, 28)? {
        fields(
            part,
            &[
                "id",
                "name",
                "tone",
                "selectable",
                "about",
                "quote",
                "shapes",
                "icon",
                "layer",
                "level",
            ],
        )?;
        let id = literal(&part["id"], 40, false)?;
        if !id.as_bytes()[0].is_ascii_lowercase()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !ids.insert(id)
        {
            return Err(invalid("invalid or duplicate illustration part id"));
        }
        literal(&part["name"], 80, false)?;
        option(&part["tone"], TONES)?;
        let selectable = boolean(&part["selectable"])?;
        any_selectable |= selectable;
        if selectable || part.get("about").is_some() {
            literal(&part["about"], 600, false)?;
        }
        if selectable || part.get("quote").is_some() {
            let quote = literal(&part["quote"], 400, false)?;
            if !passage.contains(quote) {
                return Err(invalid("part quote missing from passage"));
            }
        }
        if let Some(items) = part.get("shapes") {
            shapes(items, dimensions, &mut total)?;
        }
        if let Some(icon) = part.get("icon") {
            fields(icon, &["name", "x", "y", "size"])?;
            option(&icon["name"], GLYPHS)?;
            let x = number(&icon["x"], 0., dimensions.0)?;
            let y = number(&icon["y"], 0., dimensions.1)?;
            positive(&icon["size"], (dimensions.0 - x).min(dimensions.1 - y))?;
        } else if part.get("shapes").is_none() {
            return Err(invalid("a part needs geometry or a library glyph"));
        }
        if let Some(v) = part.get("layer") {
            if number(v, -3., 3.)?.fract() != 0. {
                return Err(invalid("invalid drawing layer"));
            }
        }
        if let Some(v) = part.get("level") {
            number(v, 0., 1.)?;
        }
    }
    if !any_selectable {
        return Err(invalid("a drawing needs an explorable part"));
    }
    if let Some(states) = value.get("states") {
        fields(states, &["label", "items"])?;
        literal(&states["label"], 80, false)?;
        for stage in list(&states["items"], 2, 8)? {
            fields(stage, &["label", "caption", "changes"])?;
            literal(&stage["label"], 80, false)?;
            literal(&stage["caption"], 600, false)?;
            let mut seen = HashSet::new();
            for c in list(&stage["changes"], 0, 28)? {
                fields(c, &["part", "shapes", "hidden", "emphasis", "level"])?;
                let id = literal(&c["part"], 40, false)?;
                if !ids.contains(id) || !seen.insert(id) {
                    return Err(invalid("unknown or duplicate stage part"));
                }
                if let Some(s) = c.get("shapes") {
                    shapes(s, dimensions, &mut total)?;
                }
                for key in ["hidden", "emphasis"] {
                    if let Some(b) = c.get(key) {
                        boolean(b)?;
                    }
                }
                if let Some(n) = c.get("level") {
                    number(n, 0., 1.)?;
                }
            }
        }
    }
    Ok(())
}
