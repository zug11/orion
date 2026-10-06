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

## Editor toolbar and ruler

The editor toolbar and More formatting menu use native Regular Liquid Glass
on macOS 26+, with identical untinted material. The shallow toolbar clips a
224-point-high Regular surface to its normal rounded bounds: the larger native
surface gives it menu-like scattering without adding a different material,
colour overlay or blur filter. Its foreground is drawn at the original size in
the middle strip, preserving crisp controls and DOM hit targets. The clip has
the toolbar's original frame and moves through the same geometry-only path.
Do not add an `NSVisualEffectView` beneath it; that second material creates a
flat grey fill. An unpadded shallow Regular view remains too transparent.
Accessibility selects the shared solid fallback before native glass is shown.
The Margins ruler retains its independent Clear material, with no tint or
additional frosting. The toolbar clip and the two other `NSGlassEffectView` surfaces are children
of the original full-viewport, pass-through NSView in the calling WKWebView. Their
frames update in one native transaction while the host retains its viewport
bounds. The two materials are not merged into a glass-effect container. This
does not change the shared window-frame glass or its settings.

Native Clear still follows macOS's Liquid Glass appearance preference. Check
System Settings → Appearance → Liquid Glass when comparing transparency; a
fully tinted system setting can obscure content even with Clear and no app tint.
During the 2 October investigation, the unchanged earlier preview also appeared
opaque with Liquid Glass Tint Amount at its maximum. The user then switched the
system setting to clear and confirmed that the ruler was clear again. The renderer's ruler
backplate was confirmed hidden and the native style was confirmed Clear.
Do not attribute that observation to toolbar grouping or parent geometry, and
do not override the user's system preference through undocumented defaults.
Compare the running app with text behind the ruler before declaring it restored.

Note actions sit above the title and subtitle, with no divider or concept/source
counts under the header. While editing, omit header bottom padding and use a
12px editor gap to place the toolbar directly beneath the subtitle.
The toolbar and ruler remain in the document flow below the title and subtitle.
They become sticky together only after scrolling past the note heading. While
editing, the writing pane disables vertical elastic overscroll, which is outside
the DOM/native geometry contract. Do not move the controls above the heading
or freeze the note heading to work around native tracking.

Ordinary scrolling uses `move_ruler_glass`: bounded coordinates tied to the
last acknowledged artwork revision, with no PNG transfer, image decoding,
material changes or foreground layout. It can only translate existing visible
surfaces; a resize or changed surface requires the full update. The renderer
retries a rejected motion once through that full path. Both paths share the
same monotonic per-WebView receipt so late movement cannot revive hidden glass.

`NativeFormattingDock` and `useNativeRulerGlass` own one bounded, caller-window
bridge. The DOM remains the authority for input, focus, accessibility, selection,
menus, undo and saved margins. Native views return no hit-test target. The ruler
scale and markers are drawn in the Clear view's `contentView`. The toolbar's
existing local SVG glyphs, labels and control states are painted into a bounded
transparent foreground at up to 2x resolution, also hosted inside its material.
This is toolbar chrome only: no document content, network image, font loading,
arbitrary SVG execution or file capture is involved. The native command accepts
only a size-checked PNG (up to 4096 by 160 pixels and 350,000 encoded characters),
never a URL or path. More formatting uses a third Regular glass surface above
the ruler, so opening it keeps both underlying materials. Its existing controls
use the same local foreground painter, bounded separately to 1024 by 1536 pixels
and 700,000 encoded characters, inside a 512 by 768 CSS-pixel viewport-bounded
menu. Menu scrolling repaints only the visible controls and a scroll indicator;
closing More hides its native surface. Foreground rendering is reused during
document scrolling. Toolbar groups are separated by whitespace only. The
painter omits group containers and spacers, retaining control outlines and
keyboard focus rings without drawing vertical dividers.

Scroll positions dispatch immediately, without another animation frame or an
IPC acknowledgement wait. Monotonic revisions reject stale native arrivals and
renderer responses. Layout and appearance updates are coalesced. A scoped
zero-duration `NSAnimationContext` and `CATransaction` with actions disabled move
both glass views together in viewport coordinates and retain their foregrounds.
Vertical scroll does not recalculate paragraph margins. Unmount/hide
removes the glass and foregrounds; a hidden noninteractive view retains only the
last revision until its WKWebView closes. All ownership is window-local.

The renderer hides its matching artwork only after native activation succeeds.
Other overlapping HTML menus/dialogs, an actively edited numeric toolbar field,
unsupported systems, native failures and accessibility requests use the existing
HTML controls. Browser preview stays on HTML. Native drawing failures must never
hide a control. The ruler fallback is solid with a uniform border. Its visual end
caps remain separate from horizontal measurement, and its 0/100 tick stems stay
omitted. Apple's material supplies the refraction and edge lighting; there is no
CSS blur shader or custom highlight stroke on the native surfaces.
