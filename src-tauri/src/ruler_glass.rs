//! A narrow native foreground for the editor ruler. The renderer owns document
//! state and input; this window-owned view draws the same state inside Apple's
//! Clear NSGlassEffectView. It never intercepts a click or becomes first responder.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Viewport {
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolbarPaint {
    png: String,
    width: u32,
    height: u32,
}

impl ToolbarPaint {
    fn bytes(&self) -> Result<Vec<u8>, String> {
        self.bounded_bytes(4096, 160, 350_000)
    }

    fn menu_bytes(&self) -> Result<Vec<u8>, String> {
        self.bounded_bytes(1024, 1536, 700_000)
    }

    fn bounded_bytes(&self, width: u32, height: u32, encoded: usize) -> Result<Vec<u8>, String> {
        if self.png.len() > encoded
            || self.width == 0
            || self.width > width
            || self.height == 0
            || self.height > height
        {
            return Err("The toolbar foreground is too large.".into());
        }
        let bytes = STANDARD
            .decode(&self.png)
            .map_err(|_| "The toolbar foreground is invalid.")?;
        if bytes.len() < 33
            || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
            || &bytes[8..16] != b"\0\0\0\rIHDR"
            || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != self.width
            || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != self.height
            || bytes[24] != 8
            || ![2, 6].contains(&bytes[25])
        {
            return Err("The toolbar foreground is not a bounded PNG.".into());
        }
        Ok(bytes)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolbarVisual {
    frame: Frame,
    paint: ToolbarPaint,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Side {
    Left,
    Right,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RulerGlassRequest {
    sequence: u64,
    visible: bool,
    frame: Option<Frame>,
    viewport: Option<Viewport>,
    left: Option<f64>,
    right: Option<f64>,
    left_position: Option<f64>,
    right_position: Option<f64>,
    active_side: Option<Side>,
    focused_side: Option<Side>,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    compact: bool,
    foreground: Option<[f64; 4]>,
    muted: Option<[f64; 4]>,
    accent: Option<[f64; 4]>,
    #[serde(default)]
    dark: bool,
    #[serde(default = "default_true")]
    ruler_visible: bool,
    toolbar: Option<ToolbarVisual>,
    menu: Option<ToolbarVisual>,
}

#[derive(Clone, Debug)]
struct RulerVisual {
    frame: Frame,
    viewport: Viewport,
    left: Option<f64>,
    right: Option<f64>,
    left_position: f64,
    right_position: f64,
    active_side: Option<Side>,
    focused_side: Option<Side>,
    disabled: bool,
    compact: bool,
    foreground: [f64; 4],
    muted: [f64; 4],
    accent: [f64; 4],
    dark: bool,
    ruler_visible: bool,
    toolbar: Option<ToolbarVisual>,
    menu: Option<ToolbarVisual>,
}

impl RulerVisual {
    /// Scrolling only translates the native surface. It does not invalidate its
    /// foreground drawing or change the glass material/appearance.
    fn has_same_paint_as(&self, previous: &Self) -> bool {
        self.frame.width == previous.frame.width
            && self.frame.height == previous.frame.height
            && self.left == previous.left
            && self.right == previous.right
            && self.left_position == previous.left_position
            && self.right_position == previous.right_position
            && self.active_side == previous.active_side
            && self.focused_side == previous.focused_side
            && self.disabled == previous.disabled
            && self.compact == previous.compact
            && self.foreground == previous.foreground
            && self.muted == previous.muted
            && self.accent == previous.accent
            && self.dark == previous.dark
    }
}

fn bounded(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

impl RulerGlassRequest {
    fn validate(self) -> Result<Option<RulerVisual>, String> {
        if self.sequence == 0 || self.sequence > 9_007_199_254_740_991 {
            return Err("The ruler update sequence is invalid.".to_string());
        }
        if !self.visible {
            return Ok(None);
        }
        let invalid = || "The ruler geometry or colours are invalid.".to_string();
        let frame = self.frame.ok_or_else(invalid)?;
        let viewport = self.viewport.ok_or_else(invalid)?;
        if !bounded(viewport.width, 1.0, 32768.0)
            || !bounded(viewport.height, 1.0, 32768.0)
            || !bounded(frame.width, 24.0, viewport.width)
            || !bounded(frame.height, 24.0, 80.0)
            || !bounded(frame.x, 0.0, viewport.width - frame.width)
            || !bounded(frame.y, 0.0, viewport.height - frame.height)
        {
            return Err(invalid());
        }
        let left_position = self.left_position.ok_or_else(invalid)?;
        let right_position = self.right_position.ok_or_else(invalid)?;
        // Positions also include document margins and list/quote indentation;
        // only the stored paragraph percentages themselves have a 25% ceiling.
        if !bounded(left_position, 0.0, frame.width)
            || !bounded(right_position, left_position, frame.width)
            || self.left.is_some_and(|v| !bounded(v, 0.0, 25.0))
            || self.right.is_some_and(|v| !bounded(v, 0.0, 25.0))
        {
            return Err(invalid());
        }
        let foreground = self.foreground.ok_or_else(invalid)?;
        let muted = self.muted.ok_or_else(invalid)?;
        let accent = self.accent.ok_or_else(invalid)?;
        if [foreground, muted, accent]
            .iter()
            .flatten()
            .any(|v| !bounded(*v, 0.0, 1.0))
        {
            return Err(invalid());
        }
        if let Some(toolbar) = &self.toolbar {
            let frame = toolbar.frame;
            if !bounded(frame.width, 24.0, viewport.width.min(2048.0))
                || !bounded(frame.height, 24.0, 80.0)
                || !bounded(frame.x, 0.0, viewport.width - frame.width)
                || !bounded(frame.y, 0.0, viewport.height - frame.height)
            {
                return Err(invalid());
            }
            toolbar.paint.bytes()?;
        }
        if let Some(menu) = &self.menu {
            let frame = menu.frame;
            if self.toolbar.is_none()
                || !bounded(frame.width, 24.0, viewport.width.min(512.0))
                || !bounded(frame.height, 24.0, viewport.height.min(768.0))
                || !bounded(frame.x, 0.0, viewport.width - frame.width)
                || !bounded(frame.y, 0.0, viewport.height - frame.height)
            {
                return Err(invalid());
            }
            menu.paint.menu_bytes()?;
        }
        Ok(Some(RulerVisual {
            frame,
            viewport,
            left: self.left,
            right: self.right,
            left_position,
            right_position,
            active_side: self.active_side,
            focused_side: self.focused_side,
            disabled: self.disabled,
            compact: self.compact,
            foreground,
            muted,
            accent,
            dark: self.dark,
            ruler_visible: self.ruler_visible,
            toolbar: self.toolbar,
            menu: self.menu,
        }))
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulerGlassStatus {
    active: bool,
    available: bool,
}

#[derive(Default)]
struct RulerReceipt {
    sequence: u64,
    paint_sequence: u64,
    status: RulerGlassStatus,
}

impl RulerReceipt {
    fn accept(&mut self, sequence: u64) -> bool {
        if sequence <= self.sequence {
            return false;
        }
        self.sequence = sequence;
        true
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RulerMotionRequest {
    sequence: u64,
    base_sequence: u64,
    viewport: Viewport,
    frame: Frame,
    ruler_visible: bool,
    toolbar: Option<Frame>,
    menu: Option<Frame>,
}

impl RulerMotionRequest {
    fn validate(&self) -> Result<(), String> {
        let viewport = self.viewport;
        let valid_frame = |frame: Frame, width: f64, height: f64| {
            bounded(frame.width, 24.0, viewport.width.min(width))
                && bounded(frame.height, 24.0, viewport.height.min(height))
                && bounded(frame.x, 0.0, viewport.width - frame.width)
                && bounded(frame.y, 0.0, viewport.height - frame.height)
        };
        if self.base_sequence == 0
            || self.sequence <= self.base_sequence
            || self.sequence > 9_007_199_254_740_991
            || !bounded(viewport.width, 1.0, 32768.0)
            || !bounded(viewport.height, 1.0, 32768.0)
            || !valid_frame(self.frame, 32768.0, 80.0)
            || self
                .toolbar
                .is_some_and(|frame| !valid_frame(frame, 2048.0, 80.0))
            || self
                .menu
                .is_some_and(|frame| self.toolbar.is_none() || !valid_frame(frame, 512.0, 768.0))
        {
            return Err("The editor scroll geometry is invalid.".into());
        }
        Ok(())
    }
}

/// Scroll updates carry only coordinates for already painted surfaces. They
/// cannot replace artwork, change materials, resize controls or show a surface.
#[tauri::command]
pub async fn move_ruler_glass(
    window: WebviewWindow,
    request: RulerMotionRequest,
) -> Result<RulerGlassStatus, String> {
    request.validate()?;
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let result = unsafe { macos::move_surfaces(webview.inner(), request) };
                let _ = send.send(result);
            })
            .map_err(|_| "Orion could not reach the editor window.".to_string())?;
        receive
            .await
            .map_err(|_| "The window closed before its editor moved.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(RulerGlassStatus {
            active: false,
            available: false,
        })
    }
}

#[tauri::command]
pub async fn set_ruler_glass(
    window: WebviewWindow,
    request: RulerGlassRequest,
) -> Result<RulerGlassStatus, String> {
    let sequence = request.sequence;
    let visual = request.validate()?;
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                // Tauri runs this closure on the main thread with a live WKWebView.
                let result = unsafe { macos::apply(webview.inner(), sequence, visual) };
                let _ = send.send(result);
            })
            .map_err(|_| "Orion could not reach the ruler window.".to_string())?;
        receive
            .await
            .map_err(|_| "The window closed before its ruler updated.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, sequence, visual);
        Ok(RulerGlassStatus {
            active: false,
            available: false,
        })
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, Bool},
        AllocAnyThread, DefinedClass, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSAnimationContext, NSAppearance, NSAppearanceCustomization, NSBezierPath, NSColor,
        NSCompositingOperation, NSFont, NSFontAttributeName, NSForegroundColorAttributeName,
        NSGlassEffectView, NSGlassEffectViewStyle, NSImage, NSStringDrawing,
        NSUserInterfaceItemIdentification, NSView, NSWindowOrderingMode, NSWorkspace,
    };
    use objc2_foundation::{
        ns_string, MainThreadMarker, NSData, NSDictionary, NSObjectProtocol, NSPoint, NSRect,
        NSSize, NSString,
    };
    use std::{
        cell::{Cell, RefCell},
        ffi::c_void,
    };

    const IDENTIFIER: &str = "orion-native-ruler-overlay";
    const CAP: f64 = 8.0;

    /// A viewport update must follow the editor immediately, never inherit an
    /// enclosing AppKit animation transaction. This scope restores its caller's
    /// animation context even if a native view disappears during the update.
    struct ImmediateGeometry {
        transaction: Option<&'static AnyClass>,
    }

    impl ImmediateGeometry {
        fn new() -> Self {
            // NSAnimationContext controls AppKit animations. The glass also
            // owns Core Animation layers, whose implicit actions need their
            // own transaction; a zero AppKit duration alone is insufficient.
            let transaction = AnyClass::get(c"CATransaction");
            if let Some(class) = transaction {
                unsafe {
                    let _: () = msg_send![class, begin];
                    let _: () = msg_send![class, setDisableActions: Bool::YES];
                    let _: () = msg_send![class, setAnimationDuration: 0.0_f64];
                }
            }
            NSAnimationContext::beginGrouping();
            let context = NSAnimationContext::currentContext();
            context.setDuration(0.0);
            context.setAllowsImplicitAnimation(false);
            Self { transaction }
        }
    }

    impl Drop for ImmediateGeometry {
        fn drop(&mut self) {
            NSAnimationContext::endGrouping();
            if let Some(class) = self.transaction {
                unsafe {
                    let _: () = msg_send![class, commit];
                }
            }
        }
    }

    #[derive(Default)]
    struct RulerIvars {
        visual: RefCell<Option<RulerVisual>>,
        receipt: RefCell<RulerReceipt>,
        toolbar: RefCell<Option<(ToolbarPaint, Retained<NSImage>)>>,
        paint_height: Cell<f64>,
    }

    define_class!(
        // A drawing-only NSView with no responder or document state. Both the
        // overlay and glass content use it; only the latter receives visual data.
        #[unsafe(super = NSView)]
        #[thread_kind = MainThreadOnly]
        #[ivars = RulerIvars]
        struct OrionRulerGlassView;

        unsafe impl NSObjectProtocol for OrionRulerGlassView {}

        impl OrionRulerGlassView {
            #[unsafe(method(isFlipped))]
            fn is_flipped(&self) -> bool { true }

            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> *mut NSView { std::ptr::null_mut() }

            #[unsafe(method(acceptsFirstResponder))]
            fn accepts_first_responder(&self) -> bool { false }

            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                if let Some((_, image)) = self.ivars().toolbar.borrow().as_ref() {
                    let mut frame = self.bounds();
                    let height = self.ivars().paint_height.get();
                    if height > 0.0 {
                        frame.origin.y += (frame.size.height - height) / 2.0;
                        frame.size.height = height;
                    }
                    unsafe { image.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
                        frame, NSRect::ZERO, NSCompositingOperation::SourceOver, 1.0, true, None,
                    ); }
                    return;
                }
                if let Some(visual) = self.ivars().visual.borrow().as_ref() {
                    draw_ruler(visual);
                }
            }
        }
    );

    impl OrionRulerGlassView {
        fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(RulerIvars::default());
            // initWithFrame is NSView's designated initializer.
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }
    }

    fn color(rgba: [f64; 4], opacity: f64) -> Retained<NSColor> {
        NSColor::colorWithSRGBRed_green_blue_alpha(rgba[0], rgba[1], rgba[2], rgba[3] * opacity)
    }

    fn text(label: &str, center: f64, y: f64, rgba: [f64; 4], opacity: f64, edge: i8) {
        let label = NSString::from_str(label);
        let font = NSFont::systemFontOfSize(10.0);
        let ink = color(rgba, opacity);
        // Each attribute key is paired with the documented NSFont/NSColor type.
        let attributes = unsafe {
            NSDictionary::from_slices(
                &[NSFontAttributeName, NSForegroundColorAttributeName],
                &[&*font as &AnyObject, &*ink as &AnyObject],
            )
        };
        unsafe {
            let size = label.sizeWithAttributes(Some(&attributes));
            let x = match edge {
                -1 => center + 3.0,
                1 => center - size.width - 3.0,
                _ => center - size.width / 2.0,
            };
            label.drawAtPoint_withAttributes(NSPoint::new(x, y), Some(&attributes));
        }
    }

    fn draw_ruler(v: &RulerVisual) {
        let opacity = if v.disabled { 0.4 } else { 1.0 };
        let h = v.frame.height;
        for tick in 0..=50 {
            let value = tick * 2;
            let x = CAP + v.frame.width * f64::from(value) / 100.0;
            let major = value % 10 == 0;
            if tick != 0 && tick != 50 {
                color(v.muted, opacity * if major { 1.0 } else { 0.55 }).setFill();
                let length = if major { 7.0 } else { 4.0 };
                NSBezierPath::fillRect(NSRect::new(
                    NSPoint::new(x - 0.5, h - 8.0 - length),
                    NSSize::new(1.0, length),
                ));
            }
            if major && (!v.compact || value % 20 == 0) {
                let label = if value == 0 || value == 100 {
                    format!("{value}%")
                } else {
                    value.to_string()
                };
                text(
                    &label,
                    x,
                    h - 32.0,
                    v.foreground,
                    opacity,
                    if value == 0 {
                        -1
                    } else if value == 100 {
                        1
                    } else {
                        0
                    },
                );
            }
        }
        for (side, position, value) in [
            (Side::Left, v.left_position, v.left),
            (Side::Right, v.right_position, v.right),
        ] {
            let x = CAP + position;
            let selected = v.active_side == Some(side) || v.focused_side == Some(side);
            let ink = if selected { v.accent } else { v.foreground };
            color(ink, opacity * if value.is_none() { 0.6 } else { 1.0 }).setFill();
            let marker = NSBezierPath::bezierPath();
            marker.moveToPoint(NSPoint::new(x - 5.0, 3.0));
            marker.lineToPoint(NSPoint::new(x + 5.0, 3.0));
            marker.lineToPoint(NSPoint::new(x + 5.0, 5.5));
            marker.lineToPoint(NSPoint::new(x, 11.0));
            marker.lineToPoint(NSPoint::new(x - 5.0, 5.5));
            marker.closePath();
            marker.fill();
            if v.focused_side == Some(side) {
                color(v.accent, opacity).setStroke();
                let focus = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
                    NSRect::new(NSPoint::new(x - 6.0, 1.0), NSSize::new(12.0, h - 2.0)),
                    4.0,
                    4.0,
                );
                focus.setLineWidth(1.5);
                focus.stroke();
            }
        }
    }

    fn hide_surface(host: &NSView, identifier: &str) {
        for view in host.subviews() {
            if view
                .identifier()
                .is_some_and(|id| id.to_string() == identifier)
            {
                view.setHidden(true);
            }
        }
    }

    fn glass_surface(
        host: &NSView,
        identifier: &str,
        frame: NSRect,
        style: NSGlassEffectViewStyle,
        mtm: MainThreadMarker,
    ) -> Result<(Retained<NSGlassEffectView>, bool), String> {
        let existing = host.subviews().iter().find(|view| {
            view.identifier()
                .is_some_and(|id| id.to_string() == identifier)
        });
        let (glass, created) = if let Some(view) = existing {
            (
                unsafe {
                    Retained::retain(
                        Retained::as_ptr(&view)
                            .cast_mut()
                            .cast::<NSGlassEffectView>(),
                    )
                }
                .ok_or("The editor surface is unavailable.")?,
                false,
            )
        } else {
            let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), frame);
            glass.setIdentifier(Some(&NSString::from_str(identifier)));
            glass.setStyle(style);
            glass.setCornerRadius(11.0);
            glass.setTintColor(None);
            let _: () = unsafe { msg_send![&*glass, setAccessibilityElement: Bool::NO] };
            let drawing = OrionRulerGlassView::new(mtm, glass.bounds());
            let _: () = unsafe { msg_send![&*drawing, setAccessibilityElement: Bool::NO] };
            glass.setContentView(Some(&drawing));
            host.addSubview(&glass);
            (glass, true)
        };
        let resized = glass.frame().size != frame.size;
        if resized {
            glass.setFrame(frame);
        } else if glass.frame().origin != frame.origin {
            glass.setFrameOrigin(frame.origin);
        }
        if created || resized {
            glass.layoutSubtreeIfNeeded();
        }
        Ok((glass, created))
    }

    /// A shallow Regular surface has much less scattering than the More menu.
    /// Keep a menu-sized native material and expose only its middle strip. The
    /// pass-through clip moves with the toolbar; its foreground stays at its
    /// original size. No second material, tint, filter or snapshot is involved.
    fn toolbar_surface(
        host: &NSView,
        frame: NSRect,
        mtm: MainThreadMarker,
    ) -> Result<(Retained<NSGlassEffectView>, bool), String> {
        let identifier = ns_string!("orion-toolbar-glass");
        let clip = if let Some(view) = host
            .subviews()
            .iter()
            .find(|view| view.identifier().as_deref() == Some(identifier))
        {
            view
        } else {
            let view = OrionRulerGlassView::new(mtm, frame);
            view.setIdentifier(Some(identifier));
            view.setWantsLayer(true);
            let layer: Option<Retained<AnyObject>> = unsafe { msg_send![&*view, layer] };
            if let Some(layer) = layer {
                let _: () = unsafe { msg_send![&*layer, setCornerRadius: 11.0_f64] };
                let _: () = unsafe { msg_send![&*layer, setMasksToBounds: Bool::YES] };
            }
            let _: () = unsafe { msg_send![&*view, setAccessibilityElement: Bool::NO] };
            host.addSubview(&view);
            Retained::into_super(view)
        };
        if clip.frame().size != frame.size {
            clip.setFrame(frame);
        } else if clip.frame().origin != frame.origin {
            clip.setFrameOrigin(frame.origin);
        }
        clip.setHidden(false);
        // Match More's 224-point minimum breadth, independently of whether
        // that menu is currently open. The extra area is always clipped.
        let height = frame.size.height.max(224.0);
        glass_surface(
            &clip,
            "orion-toolbar-material",
            NSRect::new(
                NSPoint::new(0.0, (frame.size.height - height) / 2.0),
                NSSize::new(frame.size.width, height),
            ),
            NSGlassEffectViewStyle::Regular,
            mtm,
        )
    }

    pub unsafe fn move_surfaces(
        content: *mut c_void,
        request: RulerMotionRequest,
    ) -> Result<RulerGlassStatus, String> {
        let _mtm = MainThreadMarker::new().ok_or("The editor requires the macOS main thread.")?;
        let webview = unsafe { &*content.cast::<NSView>() };
        let overlay = webview
            .subviews()
            .iter()
            .find(|view| {
                view.identifier()
                    .is_some_and(|id| id.to_string() == IDENTIFIER)
            })
            .ok_or("The editor scroll surface is unavailable.")?;
        let receipt_view = unsafe { &*(Retained::as_ptr(&overlay).cast::<OrionRulerGlassView>()) };
        let mut receipt = receipt_view.ivars().receipt.borrow_mut();
        if request.sequence <= receipt.sequence {
            return Ok(receipt.status);
        }
        if request.base_sequence != receipt.paint_sequence {
            return Err("The editor scroll artwork changed.".into());
        }
        if !receipt.status.active || overlay.isHidden() || overlay.frame() != webview.bounds() {
            return Err("The editor scroll surface needs a layout update.".into());
        }
        let bounds = webview.bounds();
        let scale_x = bounds.size.width / request.viewport.width;
        let scale_y = bounds.size.height / request.viewport.height;
        if !bounded(scale_x, 0.25, 4.0) || !bounded(scale_y, 0.25, 4.0) {
            return Err("The editor scroll scale is invalid.".into());
        }
        let ruler = request.ruler_visible.then_some(Frame {
            x: request.frame.x - CAP,
            width: request.frame.width + CAP * 2.0,
            ..request.frame
        });
        let children = overlay.subviews();
        let mut moves = Vec::new();
        for (identifier, frame) in [
            ("orion-toolbar-glass", request.toolbar),
            ("orion-ruler-glass", ruler),
            ("orion-more-glass", request.menu),
        ] {
            let child = children.iter().find(|view| {
                view.identifier()
                    .is_some_and(|id| id.to_string() == identifier)
            });
            match (child, frame) {
                (Some(view), Some(frame)) if !view.isHidden() => {
                    let size = NSSize::new(frame.width * scale_x, frame.height * scale_y);
                    if (view.frame().size.width - size.width).abs() > 0.02
                        || (view.frame().size.height - size.height).abs() > 0.02
                    {
                        return Err("The editor scroll surface must not resize.".into());
                    }
                    moves.push((view, NSPoint::new(frame.x * scale_x, frame.y * scale_y)));
                }
                (None, None) => {}
                (Some(view), None) if view.isHidden() => {}
                _ => return Err("The editor scroll surfaces changed.".into()),
            }
        }
        let _geometry = ImmediateGeometry::new();
        for (view, origin) in moves {
            if view.frame().origin != origin {
                view.setFrameOrigin(origin);
            }
        }
        receipt.accept(request.sequence);
        Ok(receipt.status)
    }

    pub unsafe fn apply(
        content: *mut c_void,
        sequence: u64,
        visual: Option<RulerVisual>,
    ) -> Result<RulerGlassStatus, String> {
        let mtm = MainThreadMarker::new().ok_or("The ruler requires the macOS main thread.")?;
        let _geometry = ImmediateGeometry::new();
        let webview = unsafe { &*content.cast::<NSView>() };
        let existing = webview.subviews().iter().find(|view| {
            view.identifier()
                .is_some_and(|id| id.to_string() == IDENTIFIER)
        });
        let bounds = webview.bounds();
        let overlay = if let Some(view) = existing {
            view
        } else {
            let view = OrionRulerGlassView::new(mtm, bounds);
            view.setIdentifier(Some(ns_string!("orion-native-ruler-overlay")));
            let _: () = unsafe { msg_send![&*view, setAccessibilityElement: Bool::NO] };
            // Since hitTest always returns nil, DOM sliders underneath remain
            // the only input and accessibility controls. No focus is stolen.
            webview.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Above, None);
            Retained::into_super(view)
        };
        // Keep a lightweight, hidden receipt in this WebView after removal of
        // the glass. A late show or hide cannot resurrect/erase a newer ruler.
        let receipt_view = unsafe { &*(Retained::as_ptr(&overlay).cast::<OrionRulerGlassView>()) };
        let mut receipt = receipt_view.ivars().receipt.borrow_mut();
        if !receipt.accept(sequence) {
            return Ok(receipt.status);
        }
        receipt.paint_sequence = sequence;
        let available = AnyClass::get(c"NSGlassEffectView").is_some();
        receipt.status = RulerGlassStatus {
            active: false,
            available,
        };
        let workspace = NSWorkspace::sharedWorkspace();
        let reduced: Bool =
            unsafe { msg_send![&*workspace, accessibilityDisplayShouldReduceTransparency] };
        let contrast: Bool =
            unsafe { msg_send![&*workspace, accessibilityDisplayShouldIncreaseContrast] };
        let hide = || {
            overlay.setHidden(true);
            for child in overlay.subviews() {
                child.removeFromSuperview();
            }
        };
        if visual.is_none() || !available || reduced.as_bool() || contrast.as_bool() {
            hide();
            return Ok(receipt.status);
        }
        let mut visual = visual.expect("The visible branch checked the visual.");
        let menu = visual.menu.take();
        let scale_x = bounds.size.width / visual.viewport.width;
        let scale_y = bounds.size.height / visual.viewport.height;
        if !bounded(scale_x, 0.25, 4.0) || !bounded(scale_y, 0.25, 4.0) {
            hide();
            return Ok(receipt.status);
        }
        // Retain the ruler's original full-WebView host. Both native surfaces
        // receive their viewport positions in this one transaction.
        let ruler = Frame {
            x: visual.frame.x - CAP,
            width: visual.frame.width + CAP * 2.0,
            ..visual.frame
        };
        if overlay.frame() != bounds {
            overlay.setFrame(bounds);
        }
        // Share geometry, not a glass-effect group. Keeping independent effect
        // views preserves the ruler's original Clear material beside Regular.
        let host = overlay.clone();
        let local_frame = |frame: Frame| {
            NSRect::new(
                NSPoint::new(frame.x * scale_x, frame.y * scale_y),
                NSSize::new(frame.width * scale_x, frame.height * scale_y),
            )
        };
        let appearance = NSAppearance::appearanceNamed(if visual.dark {
            ns_string!("NSAppearanceNameDarkAqua")
        } else {
            ns_string!("NSAppearanceNameAqua")
        });
        if let Some(toolbar) = &visual.toolbar {
            let (glass, created) = toolbar_surface(&host, local_frame(toolbar.frame), mtm)?;
            glass.setHidden(false);
            let drawing = glass
                .contentView()
                .ok_or("The toolbar drawing is unavailable.")?;
            let drawing = unsafe { &*(Retained::as_ptr(&drawing).cast::<OrionRulerGlassView>()) };
            drawing
                .ivars()
                .paint_height
                .set(toolbar.frame.height * scale_y);
            let mut prior = drawing.ivars().toolbar.borrow_mut();
            if prior
                .as_ref()
                .is_none_or(|(paint, _)| paint != &toolbar.paint)
            {
                let bytes = toolbar.paint.bytes()?;
                let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&bytes))
                    .ok_or("The toolbar foreground could not be decoded.")?;
                *prior = Some((toolbar.paint.clone(), image));
                drawing.setNeedsDisplay(true);
            }
            if created || glass.appearance().as_deref() != appearance.as_deref() {
                glass.setAppearance(appearance.as_deref());
            }
        } else {
            hide_surface(&host, "orion-toolbar-glass");
        }
        if visual.ruler_visible {
            let (glass, created) = glass_surface(
                &host,
                "orion-ruler-glass",
                local_frame(ruler),
                NSGlassEffectViewStyle::Clear,
                mtm,
            )?;
            glass.setHidden(false);
            let drawing = glass
                .contentView()
                .ok_or("The ruler drawing is unavailable.")?;
            let drawing = unsafe { &*(Retained::as_ptr(&drawing).cast::<OrionRulerGlassView>()) };
            let (theme_changed, paint_changed) = {
                let previous = drawing.ivars().visual.borrow();
                (
                    previous
                        .as_ref()
                        .is_none_or(|previous| previous.dark != visual.dark),
                    previous
                        .as_ref()
                        .is_none_or(|previous| !visual.has_same_paint_as(previous)),
                )
            };
            if created || theme_changed {
                glass.setAppearance(appearance.as_deref());
            }
            let drawing_bounds = NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(visual.frame.width + CAP * 2.0, visual.frame.height),
            );
            if drawing.bounds() != drawing_bounds {
                drawing.setBounds(drawing_bounds);
            }
            *drawing.ivars().visual.borrow_mut() = Some(visual);
            if paint_changed {
                drawing.setNeedsDisplay(true);
            }
        } else {
            hide_surface(&host, "orion-ruler-glass");
        }
        if let Some(menu) = menu {
            let (glass, created) = glass_surface(
                &host,
                "orion-more-glass",
                local_frame(menu.frame),
                NSGlassEffectViewStyle::Regular,
                mtm,
            )?;
            let drawing = glass
                .contentView()
                .ok_or("The menu drawing is unavailable.")?;
            let drawing = unsafe { &*(Retained::as_ptr(&drawing).cast::<OrionRulerGlassView>()) };
            let mut prior = drawing.ivars().toolbar.borrow_mut();
            if prior.as_ref().is_none_or(|(paint, _)| paint != &menu.paint) {
                let bytes = menu.paint.menu_bytes()?;
                let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&bytes))
                    .ok_or("The menu foreground could not be decoded.")?;
                *prior = Some((menu.paint, image));
                drawing.setNeedsDisplay(true);
            }
            if created || glass.appearance().as_deref() != appearance.as_deref() {
                glass.setAppearance(appearance.as_deref());
            }
            // More can overlap the ruler. Keep its material and foreground
            // together above both surfaces, even if the ruler was just added.
            if host.subviews().iter().last().is_none_or(|last| {
                !last
                    .identifier()
                    .is_some_and(|id| id.to_string() == "orion-more-glass")
            }) {
                host.addSubview_positioned_relativeTo(&glass, NSWindowOrderingMode::Above, None);
            }
            glass.setHidden(false);
        } else {
            hide_surface(&host, "orion-more-glass");
        }
        overlay.setHidden(false);
        receipt.status.active = true;
        Ok(receipt.status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_motion_is_bounded_and_cannot_supply_artwork() {
        let valid = serde_json::json!({
            "sequence": 12, "baseSequence": 10,
            "viewport": {"width":1200,"height":800},
            "frame": {"x":80,"y":120,"width":680,"height":44},
            "rulerVisible": true,
            "toolbar": {"x":80,"y":70,"width":680,"height":44}
        });
        let validate = |value| {
            serde_json::from_value::<RulerMotionRequest>(value)
                .unwrap()
                .validate()
        };
        assert!(validate(valid.clone()).is_ok());
        let mut outside = valid.clone();
        outside["frame"]["y"] = serde_json::json!(-1);
        assert!(validate(outside).is_err());
        let mut reversed = valid.clone();
        reversed["baseSequence"] = serde_json::json!(12);
        assert!(validate(reversed).is_err());
        let mut large = valid.clone();
        large["viewport"]["width"] = serde_json::json!(32769);
        assert!(validate(large).is_err());
        let mut artwork = valid;
        artwork["paint"] = serde_json::json!({"png":"not allowed"});
        assert!(serde_json::from_value::<RulerMotionRequest>(artwork).is_err());
    }

    fn request() -> serde_json::Value {
        serde_json::json!({
            "sequence":1, "visible":true, "frame":{"x":80,"y":120,"width":680,"height":44},
            "viewport":{"width":1200,"height":800}, "left":0,"right":0,
            "leftPosition":0,"rightPosition":680,"activeSide":null,"focusedSide":null,
            "disabled":false,"compact":false,"dark":false,
            "foreground":[0.2,0.2,0.2,1],"muted":[0.5,0.5,0.5,1],"accent":[0.3,0.4,0.8,1]
        })
    }

    #[test]
    fn toolbar_foreground_rejects_unbounded_or_disguised_images_before_decoding() {
        let mut bytes = vec![0; 33];
        bytes[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
        bytes[16..20].copy_from_slice(&1680_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&96_u32.to_be_bytes());
        bytes[24] = 8;
        bytes[25] = 6;
        let paint = ToolbarPaint {
            png: STANDARD.encode(&bytes),
            width: 1680,
            height: 96,
        };
        assert!(paint.bytes().is_ok());
        let mut wrong = paint.clone();
        wrong.width = 1;
        assert!(wrong.bytes().is_err());
        let mut giant = paint.clone();
        giant.height = 161;
        assert!(giant.bytes().is_err());
        let mut huge = paint.clone();
        huge.png = "a".repeat(350_001);
        assert!(huge.bytes().is_err());
        let mut disguised = paint.clone();
        disguised.png = STANDARD.encode(b"<svg onload='bad()'/>");
        assert!(disguised.bytes().is_err());
        bytes[25] = 3; // No indexed/palette images or unexpected formats.
        let indexed = ToolbarPaint {
            png: STANDARD.encode(&bytes),
            ..paint
        };
        assert!(indexed.bytes().is_err());
    }

    #[test]
    fn menu_foreground_has_separate_bounded_dimensions_and_requires_its_toolbar() {
        fn paint(width: u32, height: u32) -> serde_json::Value {
            let mut bytes = vec![0; 33];
            bytes[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
            bytes[16..20].copy_from_slice(&width.to_be_bytes());
            bytes[20..24].copy_from_slice(&height.to_be_bytes());
            bytes[24] = 8;
            bytes[25] = 6;
            serde_json::json!({"png":STANDARD.encode(bytes),"width":width,"height":height})
        }
        let mut valid = request();
        valid["toolbar"] = serde_json::json!({"frame":{"x":80,"y":70,"width":680,"height":44},"paint":paint(1360,88)});
        valid["menu"] = serde_json::json!({"frame":{"x":520,"y":120,"width":240,"height":400},"paint":paint(480,800)});
        let validate = |value| {
            serde_json::from_value::<RulerGlassRequest>(value)
                .unwrap()
                .validate()
        };
        assert!(validate(valid.clone()).is_ok());
        for (field, value) in [("width", 513), ("height", 769), ("x", 1190), ("y", 790)] {
            let mut invalid = valid.clone();
            invalid["menu"]["frame"][field] = value.into();
            assert!(validate(invalid).is_err());
        }
        let mut invalid = valid.clone();
        invalid["toolbar"] = serde_json::Value::Null;
        assert!(validate(invalid).is_err());
        let mut invalid = valid.clone();
        invalid["menu"]["paint"] = paint(1025, 800);
        assert!(validate(invalid).is_err());
        let mut invalid = valid.clone();
        invalid["menu"]["paint"] = paint(480, 1537);
        assert!(validate(invalid).is_err());
        let mut invalid = valid;
        invalid["menu"]["paint"]["png"] = "a".repeat(700_001).into();
        assert!(validate(invalid).is_err());
    }

    #[test]
    fn late_scroll_and_unmount_updates_cannot_replace_newer_window_state() {
        let mut receipt = RulerReceipt::default();
        assert!(receipt.accept(100));
        receipt.status.active = true;
        assert!(receipt.accept(103));
        receipt.status.active = false; // Ruler closed while scroll was in flight.
        assert!(!receipt.accept(102));
        assert!(!receipt.accept(103));
        assert!(!receipt.status.active);
        assert!(receipt.accept(105)); // A replacement ruler opened.
        receipt.status.active = true;
        assert!(!receipt.accept(104)); // Old unmount hide arrived late.
        assert!(receipt.status.active);
        assert!(RulerReceipt::default().accept(1)); // Other windows are independent.
    }

    #[test]
    fn native_ruler_accepts_visible_and_minimal_hide_requests() {
        assert!(serde_json::from_value::<RulerGlassRequest>(request())
            .unwrap()
            .validate()
            .unwrap()
            .is_some());
        assert!(serde_json::from_value::<RulerGlassRequest>(
            serde_json::json!({"sequence":1,"visible":false})
        )
        .unwrap()
        .validate()
        .unwrap()
        .is_none());
        let mut mixed = request();
        mixed["left"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<RulerGlassRequest>(mixed)
            .unwrap()
            .validate()
            .is_ok());
    }

    #[test]
    fn native_ruler_accepts_paragraph_positions_inside_document_and_list_indents() {
        for (left, right) in [(174.0, 506.0), (260.0, 430.0)] {
            let mut indented = request();
            indented["left"] = 25.into();
            indented["right"] = 25.into();
            indented["leftPosition"] = left.into();
            indented["rightPosition"] = right.into();
            assert!(serde_json::from_value::<RulerGlassRequest>(indented)
                .unwrap()
                .validate()
                .is_ok());
        }
        let mut crossed = request();
        crossed["leftPosition"] = 500.into();
        crossed["rightPosition"] = 400.into();
        assert!(serde_json::from_value::<RulerGlassRequest>(crossed)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn native_ruler_scroll_reuses_paint_but_resize_and_handle_changes_repaint() {
        let baseline = serde_json::from_value::<RulerGlassRequest>(request())
            .unwrap()
            .validate()
            .unwrap()
            .unwrap();
        let mut scrolled = baseline.clone();
        scrolled.frame.y = 12.0;
        scrolled.frame.x = 90.0;
        assert!(scrolled.has_same_paint_as(&baseline));

        let mut resized = scrolled.clone();
        resized.frame.width = 600.0;
        assert!(!resized.has_same_paint_as(&baseline));
        let mut dragged = scrolled.clone();
        dragged.left = Some(10.0);
        dragged.left_position = 68.0;
        assert!(!dragged.has_same_paint_as(&baseline));
        let mut focused = scrolled.clone();
        focused.focused_side = Some(Side::Left);
        assert!(!focused.has_same_paint_as(&baseline));
        let mut themed = scrolled;
        themed.dark = true;
        assert!(!themed.has_same_paint_as(&baseline));
    }

    #[test]
    fn native_ruler_rejects_unbounded_geometry_colours_and_cross_window_targets() {
        for (field, value) in [
            ("leftPosition", -1.0),
            ("rightPosition", 700.0),
            ("left", 26.0),
        ] {
            let mut invalid = request();
            invalid[field] = value.into();
            assert!(serde_json::from_value::<RulerGlassRequest>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        for (field, value) in [
            ("x", -1.0),
            ("y", 780.0),
            ("width", 1300.0),
            ("height", 81.0),
        ] {
            let mut invalid = request();
            invalid["frame"][field] = value.into();
            assert!(serde_json::from_value::<RulerGlassRequest>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut invalid = request();
        invalid["foreground"] = serde_json::json!([0, 0, 0, 1.1]);
        assert!(serde_json::from_value::<RulerGlassRequest>(invalid)
            .unwrap()
            .validate()
            .is_err());
        let mut invalid = request();
        invalid["windowLabel"] = "another-window".into();
        assert!(serde_json::from_value::<RulerGlassRequest>(invalid).is_err());
        let mut non_finite = serde_json::from_value::<RulerGlassRequest>(request()).unwrap();
        non_finite.frame.as_mut().unwrap().width = f64::NAN;
        assert!(non_finite.validate().is_err());
    }
}
