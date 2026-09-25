# Native window glass

## Apple APIs and design

Research checked against Apple's documentation and the installed macOS SDK on
September 22, 2026:

- [NSGlassEffectView](https://developer.apple.com/documentation/appkit/nsglasseffectview): public native Liquid Glass, available on macOS 26 and later.
- [Build an AppKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/310/): place the content in `contentView`; a sibling glass view does not receive the same content treatment. Group multiple nearby glass shapes with `NSGlassEffectContainerView`.
- [Glass styles](https://developer.apple.com/documentation/appkit/nsglasseffectview/style-swift.enum): Regular and Clear are the supported material variants.
- [Interactive glass](https://developer.apple.com/documentation/appkit/nsglasseffectview/effectisinteractive): a public macOS 27 property, checked independently from the macOS 26 class.
- [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/): reserve glass for navigation and controls, preserve the content hierarchy, and respect system accessibility choices.
- [Behind-window blending](https://developer.apple.com/documentation/appkit/nsvisualeffectview/blendingmode-swift.enum/behindwindow): the native frosted fallback blends the desktop and windows behind Orion.

The essential AppKit composition in Swift is:

```swift
if #available(macOS 26.0, *) {
    let glass = NSGlassEffectView(frame: container.bounds)
    glass.style = .regular
    glass.cornerRadius = 16
    let content = NSView(frame: container.bounds)
    glass.contentView = content
    container.addSubview(glass)
    container.layoutSubtreeIfNeeded()
    webView.removeFromSuperview()
    webView.frame = content.bounds
    webView.autoresizingMask = [.width, .height]
    content.addSubview(webView)
    if #available(macOS 27.0, *) {
        glass.effectIsInteractive = false
    }
}
```

Orion implements this composition in Rust through `objc2-app-kit`, using the
existing Tauri WKWebView. It uses one shared glass view for the frame, so there
are no adjacent native glass shapes requiring a merging container. Opaque HTML
content covers the reading area; transparent navigation exposes the material.
AppKit owns refraction and the blur kernel. Orion does not invent unsupported
pixel blur-radius or refraction-intensity controls. The shared opacity slider controls Orion's colour
overlay, not the opacity of text or a fixed percentage of Apple's adaptive
material. The native material can still add its own opacity at zero tint.

The separate Background blur control blends a native `NSVisualEffectView`
sidebar backdrop behind the single Liquid Glass surface using the public
[`NSView.alphaValue`](https://developer.apple.com/documentation/appkit/nsview/alphavalue)
property. It adjusts added frosting from 0–100%; zero removes that backdrop.
Regular Liquid Glass retains its own system blur. In the frosted fallback,
zero leaves an unblurred transparent frame. This is a material blend, not an
unsupported blur-radius setter. It never filters or fades the text/WebView.

## Optional controls

`Settings.windowGlass` stores only `enabled`, shared `tintOpacity`, and `blur`.
The UI has one Liquid Glass switch and two sliders: Tint opacity and Background
blur. Both navigation areas use the same colour overlay and have no divider
between them, including with glass off. The reading canvas has a subtle 13 px
top-left inner curve. Its top border follows the curve, with the shared frame
tint continuing behind it. The top bar is transparent over that frame so it
does not double the tint. Its redundant Local badge and green status dot are removed.

Defaults use Regular Liquid Glass with 30% shared tint and 50% added frosting.
The renderer always requests Regular, a 16 pt corner radius, and non-interactive
glass. Turning it off or raising tint to 100% removes the native material.
Tuning survives the switch; Reset glass restores just these preferences.

The field and its members are optional at the storage boundary for older vaults.
Present values must validate; hydration supplies missing defaults. The legacy
material, style, per-area switches/tints, radius, and interaction fields still
validate so existing vaults remain readable. Hydration keeps Solid or both-off
preferences disabled and averages the enabled areas' saved tints; when both
areas were off, it averages both saved tints. The new fields take precedence if
a merge leaves legacy fields present. New saves contain the three shared fields.
Settings
follow the existing shared-settings persistence and multi-window merge flow.

Native commands accept a small typed request with a bounded radius and no
window identifier. Tauri supplies the calling window. All AppKit operations run
on its main thread; the native hierarchy retains its own views. Mode switches
move the same WebView instead of reloading it, and IPC updates are serialized.
The glass's disposable `NSView` content container absorbs AppKit's Auto Layout
constraints. The WKWebView remains a frame-sized child with width/height
autoresizing, matching Wry's layout contract. Assigning the WKWebView directly
as `contentView` changes that contract and can leave an invisible reading view
after switching materials. Removing glass detaches the WebView first, discards
the container, restores its frame/autoresizing under the original host, and
preserves the first responder.

## Compatibility and accessibility

Class lookup chooses native frosted glass when Liquid Glass is unavailable.
The interactive setter is queried before use. Browser preview saves choices but
stays opaque. A native failure selects solid renderer surfaces and is visible in
the appearance card. OS Reduce Transparency and Increase Contrast temporarily
choose solid without changing saved settings. Interactive glass is always off.

The minimum supported macOS version remains 13.3. Apple glass APIs are public;
Tauri's transparent WKWebView still requires its `macos-private-api` feature and
`app.macOSPrivateApi` setting. The current direct-distribution route remains
authoritative; Mac App Store submission would need a different WebView approach.

In solid mode, matching top and left canvas borders join at the inner curve.
The left border starts below the top bar, preserving the continuous navigation
frame. Native glass keeps its existing open left edge.
