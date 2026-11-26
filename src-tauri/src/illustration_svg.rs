use super::{persist_web_export, safe_file_stem, selected_export_path};
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const SVG_NS: &str = "http://www.w3.org/2000/svg";
fn invalid() -> String {
    "Orion could not export this drawing as a standalone SVG.".into()
}

// The desktop Save dialog accepts only the inert vocabulary emitted by the
// drawing renderer. No styles, links, external resources or caller-supplied path.
fn element(e: &BytesStart<'_>, root: bool) -> Result<(), String> {
    let name = e.name();
    if root && name.as_ref() != b"svg"
        || !matches!(
            name.as_ref(),
            b"svg"
                | b"g"
                | b"title"
                | b"circle"
                | b"ellipse"
                | b"rect"
                | b"path"
                | b"line"
                | b"polygon"
                | b"polyline"
        )
    {
        return Err(invalid());
    }
    let mut namespace = false;
    for item in e.attributes() {
        let a = item.map_err(|_| invalid())?;
        let value = std::str::from_utf8(&a.value).map_err(|_| invalid())?;
        match a.key.as_ref() {
            b"xmlns" if value == SVG_NS && name.as_ref() == b"svg" => namespace = true,
            b"fill" | b"stroke"
                if value == "none"
                    || value.strip_prefix('#').is_some_and(|hex| {
                        matches!(hex.len(), 6 | 8) && hex.bytes().all(|c| c.is_ascii_hexdigit())
                    }) => {}
            b"viewBox" | b"width" | b"height" | b"x" | b"y" | b"r" | b"rx" | b"ry" | b"cx"
            | b"cy" | b"x1" | b"x2" | b"y1" | b"y2" | b"points" | b"stroke-width"
            | b"stroke-dasharray" | b"stroke-opacity" | b"fill-opacity" | b"opacity"
                if value.bytes().all(|c| {
                    c.is_ascii_digit() || c.is_ascii_whitespace() || b"eE.,-+%".contains(&c)
                }) => {}
            b"d" if value.bytes().all(|c| {
                c.is_ascii_digit()
                    || c.is_ascii_whitespace()
                    || b"eE.,-+MmLlCcHhVvQqTtSsAaZz".contains(&c)
            }) => {}
            b"transform"
                if value.starts_with("translate(")
                    && value.ends_with(')')
                    && value[10..value.len() - 1].bytes().all(|c| {
                        c.is_ascii_digit() || c.is_ascii_whitespace() || b"eE.,-+".contains(&c)
                    }) => {}
            b"stroke-linecap" if matches!(value, "butt" | "round" | "square") => {}
            b"stroke-linejoin" if matches!(value, "miter" | "round" | "bevel") => {}
            b"vector-effect" if value == "non-scaling-stroke" => {}
            _ => return Err(invalid()),
        }
    }
    if root && !namespace {
        return Err(invalid());
    }
    Ok(())
}
fn validate(svg: &str) -> Result<(), String> {
    if svg.len() > 512 * 1024 {
        return Err(invalid());
    }
    let mut reader = Reader::from_str(svg);
    let mut depth = 0;
    let mut count = 0;
    let mut title = false;
    loop {
        match reader.read_event().map_err(|_| invalid())? {
            event @ (Event::Start(_) | Event::Empty(_)) => {
                let (tag, opens) = match event {
                    Event::Start(tag) => (tag, true),
                    Event::Empty(tag) => (tag, false),
                    _ => unreachable!(),
                };
                if title || depth == 0 && count > 0 || depth > 10 || count > 8192 {
                    return Err(invalid());
                }
                element(&tag, depth == 0)?;
                count += 1;
                if opens {
                    depth += 1;
                    title = tag.name().as_ref() == b"title";
                }
            }
            Event::End(_) => {
                if depth == 0 {
                    return Err(invalid());
                }
                depth -= 1;
                title = false;
            }
            Event::Text(t) if title || t.iter().all(u8::is_ascii_whitespace) => {}
            Event::GeneralRef(r)
                if title && matches!(&r[..], b"amp" | b"lt" | b"gt" | b"quot" | b"apos") => {}
            Event::Eof if depth == 0 && count > 0 => return Ok(()),
            _ => return Err(invalid()),
        }
    }
}

#[tauri::command]
pub(super) async fn export_illustration_svg(
    app: AppHandle,
    file_name: String,
    svg: String,
) -> Result<(), String> {
    validate(&svg)?;
    let stem = Path::new(&file_name)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Orion illustration");
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Save Orion illustration")
        .set_file_name(format!("{}.svg", safe_file_stem(stem)))
        .add_filter("SVG illustration", &["svg"])
        .blocking_save_file()
    else {
        return Ok(());
    };
    let mut path = selected_export_path(selected)?;
    if !path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        path.set_extension("svg");
    }
    tauri::async_runtime::spawn_blocking(move || persist_web_export(&path, &svg))
        .await
        .map_err(|_| "Could not finish saving the SVG.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_illustration_geometry_and_escaped_titles() {
        assert!(validate(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>A &amp; B</title><g transform="translate(0 1)"><path d="M1 2 L4 5" fill="none" stroke="#ff00eeff"/></g></svg>"##).is_ok());
    }
    #[test]
    fn refuses_active_content_and_non_drawing_documents() {
        for body in [
            "<script/>",
            "<image/>",
            "<use href='https://example.org'/>",
            "<path fill='url(x)'/>",
            "<g onclick='f()'/>",
            "<foreignObject/>",
            "<style/>",
        ] {
            assert!(validate(&format!(r#"<svg xmlns="{SVG_NS}">{body}</svg>"#)).is_err());
        }
        assert!(validate("<svg></svg>").is_err());
    }
}
