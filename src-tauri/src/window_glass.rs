//! Native window materials. The WebView lives inside the glass's contentView,
//! rather than a sibling placed above an unrelated glass backdrop. A disposable
//! content container keeps AppKit's Auto Layout away from Wry's frame-sized view.
//! https://developer.apple.com/videos/play/wwdc2025/310/
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Material {
    Solid,
    Frosted,
    Liquid,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlassStyle {
    Regular,
    Clear,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlassRequest {
    material: Material,
    style: GlassStyle,
    corner_radius: f64,
    interactive: bool,
    blur: f64,
}

impl GlassRequest {
    fn validate(&self) -> Result<(), String> {
        if !self.corner_radius.is_finite() || !(0.0..=24.0).contains(&self.corner_radius) {
            return Err("The glass corner radius must be between 0 and 24.".into());
        }
        if !self.blur.is_finite() || !(0.0..=100.0).contains(&self.blur) {
            return Err("The background blur amount must be between 0 and 100.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassStatus {
    material: Material,
    liquid_available: bool,
    interactive_available: bool,
}

#[tauri::command]
pub async fn set_window_glass(
    window: WebviewWindow,
    request: GlassRequest,
) -> Result<GlassStatus, String> {
    request.validate()?;
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                // Tauri guarantees these live handles and runs this closure on the
                // main thread. Native ownership stays entirely in this window tree.
                let result = unsafe { macos::apply(webview.ns_window(), webview.inner(), request) };
                let _ = send.send(result);
            })
            .map_err(|_| "Orion could not reach the native window.".to_string())?;
        receive
            .await
            .map_err(|_| "The window closed before its appearance updated.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, request);
        Ok(GlassStatus {
            material: Material::Solid,
            liquid_available: false,
            interactive_available: false,
        })
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, Bool},
        sel, MainThreadMarker,
    };
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle,
        NSUserInterfaceItemIdentification, NSView, NSVisualEffectBlendingMode,
        NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow,
        NSWindowOrderingMode,
    };
    use objc2_foundation::ns_string;
    use std::ffi::c_void;

    const FLEXIBLE: NSAutoresizingMaskOptions = NSAutoresizingMaskOptions::ViewWidthSizable
        .union(NSAutoresizingMaskOptions::ViewHeightSizable);

    fn identified(host: &NSView, name: &str) -> Option<Retained<NSView>> {
        host.subviews()
            .iter()
            .find(|view| view.identifier().is_some_and(|id| id.to_string() == name))
    }

    pub unsafe fn apply(
        window: *mut c_void,
        content: *mut c_void,
        request: GlassRequest,
    ) -> Result<GlassStatus, String> {
        let mtm =
            MainThreadMarker::new().ok_or("Window materials require the macOS main thread.")?;
        let window = unsafe { &*window.cast::<NSWindow>() };
        let webview = unsafe { &*content.cast::<NSView>() };
        let host = window
            .contentView()
            .ok_or("This window has no content view.")?;
        // Runtime class discovery keeps the app launchable on macOS 13–15.
        let class = AnyClass::get(c"NSGlassEffectView");
        let liquid_available = class.is_some();
        let interactive_available = class.is_some_and(|class| {
            let available: Bool = unsafe {
                msg_send![class, instancesRespondToSelector: sel!(setEffectIsInteractive:)]
            };
            available.as_bool()
        });
        let material = if request.material == Material::Liquid && !liquid_available {
            Material::Frosted
        } else {
            request.material
        };
        let first_responder = window.firstResponder();
        let mut moved_content = false;

        if material != Material::Liquid {
            if let Some(view) = identified(&host, "orion-liquid-glass") {
                // This identifier is assigned only by this module, after the
                // runtime availability check, to an NSGlassEffectView.
                let glass = unsafe { &*(Retained::as_ptr(&view).cast::<NSGlassEffectView>()) };
                // Retain and detach the actual WKWebView before disposing of the
                // container that AppKit manages with Auto Layout. Wry continues
                // to own its frame/autoresizing; it must never become the glass's
                // direct contentView (that changes its layout contract).
                let content = unsafe { Retained::retain(webview as *const NSView as *mut NSView) }
                    .ok_or("The reading view is no longer available.")?;
                content.removeFromSuperview();
                glass.setContentView(None);
                view.removeFromSuperview();
                content.setTranslatesAutoresizingMaskIntoConstraints(true);
                content.setAutoresizingMask(FLEXIBLE);
                content.setFrame(host.bounds());
                host.addSubview(&content);
                moved_content = true;
            }
        }
        if material == Material::Solid || request.blur == 0.0 {
            if let Some(view) = identified(&host, "orion-frosted-glass") {
                view.removeFromSuperview();
            }
        } else {
            // Public AppKit controls the blur kernel. The user controls how much
            // native frosting is blended behind the one Liquid Glass surface.
            // This does not blur/fade the WebView or claim to set a private radius.
            let frost = if let Some(view) = identified(&host, "orion-frosted-glass") {
                view
            } else {
                let frost = NSVisualEffectView::initWithFrame(mtm.alloc(), host.bounds());
                frost.setIdentifier(Some(ns_string!("orion-frosted-glass")));
                frost.setMaterial(NSVisualEffectMaterial::Sidebar);
                frost.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                frost.setState(NSVisualEffectState::FollowsWindowActiveState);
                frost.setAutoresizingMask(FLEXIBLE);
                host.addSubview_positioned_relativeTo(&frost, NSWindowOrderingMode::Below, None);
                Retained::into_super(frost)
            };
            frost.setAlphaValue(request.blur / 100.0);
        }
        match material {
            Material::Solid => {}
            Material::Frosted => {}
            Material::Liquid => {
                let existing = identified(&host, "orion-liquid-glass");
                let glass = if let Some(view) = existing {
                    // The hierarchy retains the same content during updates;
                    // sliders never rebuild the WebView or lose editor focus.
                    unsafe {
                        Retained::retain(
                            Retained::as_ptr(&view)
                                .cast_mut()
                                .cast::<NSGlassEffectView>(),
                        )
                    }
                    .ok_or("The glass view is no longer available.")?
                } else {
                    let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), host.bounds());
                    glass.setIdentifier(Some(ns_string!("orion-liquid-glass")));
                    glass.setAutoresizingMask(FLEXIBLE);
                    // Hold the WKWebView while moving it between retained parents.
                    let content =
                        unsafe { Retained::retain(webview as *const NSView as *mut NSView) }
                            .ok_or("The reading view is no longer available.")?;
                    let container = NSView::initWithFrame(mtm.alloc(), host.bounds());
                    container.setIdentifier(Some(ns_string!("orion-glass-content")));
                    glass.setContentView(Some(&container));
                    host.addSubview(&glass);
                    host.layoutSubtreeIfNeeded();
                    content.removeFromSuperview();
                    content.setTranslatesAutoresizingMaskIntoConstraints(true);
                    content.setAutoresizingMask(FLEXIBLE);
                    content.setFrame(container.bounds());
                    container.addSubview(&content);
                    moved_content = true;
                    glass
                };
                glass.setStyle(match request.style {
                    GlassStyle::Regular => NSGlassEffectViewStyle::Regular,
                    GlassStyle::Clear => NSGlassEffectViewStyle::Clear,
                });
                glass.setCornerRadius(request.corner_radius);
                if interactive_available {
                    // Public macOS 27 API, guarded independently of macOS 26 glass.
                    let _: () = unsafe {
                        msg_send![&*glass, setEffectIsInteractive: Bool::new(request.interactive)]
                    };
                }
            }
        }
        if moved_content {
            host.layoutSubtreeIfNeeded();
            window.makeFirstResponder(first_responder.as_deref());
        }
        window.setOpaque(material == Material::Solid);
        Ok(GlassStatus {
            material,
            liquid_available,
            interactive_available,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn glass_request_is_bounded_and_has_no_cross_window_target() {
        let value = serde_json::json!({"material":"liquid","style":"regular","cornerRadius":16,"interactive":false,"blur":50});
        assert!(serde_json::from_value::<GlassRequest>(value.clone())
            .unwrap()
            .validate()
            .is_ok());
        for radius in [-1.0, 25.0] {
            let mut invalid = value.clone();
            invalid["cornerRadius"] = radius.into();
            assert!(serde_json::from_value::<GlassRequest>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        for blur in [-1.0, 101.0] {
            let mut invalid = value.clone();
            invalid["blur"] = blur.into();
            assert!(serde_json::from_value::<GlassRequest>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut invalid = value;
        invalid["windowLabel"] = "another-window".into();
        assert!(serde_json::from_value::<GlassRequest>(invalid).is_err());
    }
}
