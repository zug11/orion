# Interface and appearance

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: themes, palettes, Home atmosphere, window glass, the app icon, typography, sidebar layout and the interface principles.

Read it before changing `src/App.css`, the theme and atmosphere modules, `src/lib/windowGlass.ts`, `src-tauri/src/window_glass.rs`, `src-tauri/src/theme_icon.rs` and layout or styling in any component.

Related: [Notes and the editor](notes-and-editor.md), [Chat](chat.md).

## Product decisions

- Appearance starts from a small curated room preset. Dark, light, and system
  are modes within that preset rather than separate themes. Keep tuning to
  accent, canvas, surface, text warmth, and contrast; optional custom accent,
  canvas, and surface colors must be validated, mode-clamped, and paired with
  derived accessible foregrounds. New visual directions must be optional and
  offer meaningful, bounded adjustments and a reset. Window glass explicitly
  uses one optional Regular surface shared by the top bar and sidebar, with
  shared tint opacity and blur blend. Keep the frame continuous without a
  divider between those areas. Do not restore style, radius, interaction, or
  per-area controls. Do not create an unbounded
  per-widget styling system. Home-atmosphere controls remain a separate persisted choice, but
  their room, readable strokes, preview, and Theme accent resolve from that
  same active palette and must react to a live System-mode appearance change.

## Persisted appearance settings

- Theme customization fields are optional at the storage boundary so older
  vaults remain valid, but are always normalized into complete runtime settings.
  System mode must react to macOS appearance changes without rewriting the
  user's selected mode or preset.
- Optional `Settings.themeIcon` defaults to true and `homeAtmosphereAppearance`
  defaults to `theme` (`dark` is the only override). These are shared appearance
  settings, not Space-specific identities. `resolveAtmosphereTheme` resolves
  Always dark from the same complete theme preferences. Scope its CSS palette to
  the Home hero, including text/actions, and use the same palette in Settings
  previews. Light atmosphere rooms are gently deepened paper tones; physical
  surface shaders use explicit diffuse/specular daylight lighting, not inverse
  emission. Mirage uses a render-resolution-aware daylight silhouette rather
  than its broad night-glow mask, and retains refraction and rim detail. Both
  modes use the same pixel budget. Preserve dark rendering, custom colour pairs,
  and bounded lifecycles.
- Named personal palettes use optional `themeSavedPalettes` and
  `themeActivePaletteId`, validated at the storage boundary and normalized on
  hydration. A saved palette contains only the bounded nine theme preferences,
  a stable `palette-` ID, and a trimmed name of at most 60 characters. Cap the
  collection at 24 unique IDs; modes and Home atmosphere settings are independent.
  Saved palettes appear alongside curated presets in the same room-preview card
  grid. Saving, overwriting, deleting, applying, and reverting are explicit UI actions.
  Tuning Canvas/Surface preserves the custom colour seed and applies relative
  tone/lift changes through `resolveThemePalette`; it must not clear a custom
  colour or silently overwrite the saved palette. Shared appearance updates
  continue across all Spaces. Older vaults have an empty palette collection.
- Home atmosphere offers only Mirage, Signal Decay, Field, Line Waves, Opal,
  and Ripple Glass. Retired recent effect IDs remain accepted at the storage
  boundary and hydrate to Mirage; older Antigravity/Constellation and
  Aurora/Liquid Ether aliases retain their Signal Decay/Line Waves migrations.
  The new glass shaders share the existing bounded local WebGL lifecycle,
  daylight shading, custom colour pair, offscreen pause, context recovery,
  and reduced-motion handling. Do not import retired shader components into
  the active renderer. Palette object refreshes with unchanged render colours must
  not recreate procedural canvases. Preserve elapsed animation time across
  colour/motion updates and WebGL context recovery; visibility pauses must
  resume the existing phase rather than restart it.
- `homeAtmosphereCustomColor` and `homeAtmosphereCustomSecondaryColor` are
  optional six-digit hex colours (or empty) at the storage boundary, hydrated
  to empty for older vaults. Together they override the first two colour
  channels across every shader and preview; derive any third channel from
  their blend and preserve readable signal contrast and the themed room.
  Older single-colour overrides keep their existing tonal companions until
  edited. Editing either picker captures the other visible colour once, then
  preserves that independent choice. Each colour has a native picker and hex
  field; choosing a preset or Reset colours clears both overrides. With neither
  set, the original multi-colour preset remains unchanged.
- Optional `Settings.windowGlass` hydrates to complete bounded defaults in
  `src/lib/windowGlass.ts`: `enabled`, shared 0–100% `tintOpacity`, and `blur`.
  Defaults are on, 30% tint, and 50% added blur. Legacy material/style, area
  switches/tints, radius, and interaction fields still validate. Hydration
  preserves an explicit Solid/both-off choice and averages the enabled areas'
  tints (both saved tints when both were off); new fields take precedence.
  Off choices retain their tuning. `src-tauri/src/window_glass.rs` owns the
  per-window native view: Liquid uses the public `NSGlassEffectView` on macOS
  26+, with a `contentView` container hosting the existing WKWebView. The
  renderer always requests Regular, a 16 pt radius, and no interaction.
  Runtime class detection falls back to a sidebar `NSVisualEffectView` on older
  Macs. The native command retains its bounded compatibility contract, including
  a guarded macOS 27 interactive setter. Never emulate Apple's glass
  with a CSS shader or put an unrelated glass sibling behind the WKWebView.
  Switches reparent the same WebView on the main thread; native views are owned
  by that window's hierarchy, not global pointers. IPC targets only its caller.
  Never assign the WKWebView directly as the glass's `contentView`: AppKit's
  Auto Layout changes break Wry's frame-based sizing on material switches.
  A disposable NSView container absorbs those constraints; the WKWebView keeps
  its width/height autoresizing and focus when moved back to the original host.
  `blur` is a bounded 0–100% mix of a native behind-window sidebar visual-effect
  backdrop. Its public `alphaValue` controls added frosting independently from
  the shared HTML colour overlay. It never fades or blurs the WebView. Zero removes
  the extra backdrop; Liquid Glass still retains Regular's system blur.
  Do not label this a pixel blur radius or use undocumented Apple filter keys.
- `useWindowGlass` serializes native material updates, ignores stale responses,
  and changes opacity through CSS without rebuilding native views. Fully hidden
  or disabled glass removes the native material. Only top/left navigation can
  reveal glass; text, controls, and the reading canvas retain full opacity.
  The reading canvas has a 13 px top-left inner radius with its top border
  following the curve. Solid mode adds a matching left border, joining the top
  edge into one continuous curved boundary; never extend it through the top bar.
  The workspace shell carries the shared frame tint
  behind that corner; keep the top bar transparent to avoid double tinting.
  New library windows apply the same shared settings through their own hook.
  Reduce Transparency/Increase Contrast select solid surfaces without rewriting
  the saved preference. Interactive glass is always disabled. Browser preview
  remains opaque. `useResolvedTheme` must call `setTheme(null)` for System so
  OS appearance changes continue propagating. Tauri's `macos-private-api` and
  `app.macOSPrivateApi` are still needed for its transparent WebView, even though
  the glass APIs themselves are public. This direct-distribution configuration
  is not compatible with Mac App Store submission. See `docs/window-glass.md`.

## UI principles

The app identity is the teal/cobalt Imprint O with no wordmark. The sidebar uses
only the freestanding O: `assets/brand/orion-imprint-symbol.png`, exported to
`public/orion-symbol.png`, with transparent surroundings and central hole. Never
add a background tile behind this sidebar mark. The original rounded renderer
master `assets/brand/orion-imprint.png` and `public/orion-mark.png` remain for
the favicon/startup screens and Codex plugin artwork.
Native desktop exports in `src-tauri/icons` instead come from the opaque,
full-bleed RGB `assets/brand/orion-imprint-native.png`. Do not export the rounded
transparent renderer tile as ICNS: macOS wraps it in an unwanted white tile.
Verify native changes using `NSWorkspace.shared.icon(forFile:)` on an actual
app bundle, not only by opening the source PNG. Release fingerprints include
both masters, public assets, and native icons so a changed icon cannot reuse a
stale app.

`themeIcon.ts` recolours the approved symbol's luminance while preserving every
alpha value; `public/orion-symbol-source.png` is an exact copy of the high-resolution
symbol master. Rendering is debounced, cached to four colour choices, and never
animated continuously. `useThemeIcon` serializes native changes, ignores late
renders, waits for vault hydration, and follows live resolved System colours.
Original restores the original mark. `theme_icon.rs` accepts only a bounded
512-pixel PNG (or nil reset), never a file path. On the main thread, only the
preferred library window may update the app-global icon. The public
`NSApplication.applicationIconImage` owns the in-memory running Dock image.
Finder always uses the packaged icon. Never call `NSWorkspace.setIcon` on the
app bundle: its FinderInfo/ResourceFork metadata invalidates strict signature
verification after launch. Never replace packaged ICNS, re-sign an installed
app, elevate permissions, target another installation, or modify a vault for this.
The same runtime-only path works from writable, read-only and translocated
bundles. Keep `set_theme_icon`'s bounded PNG/nil input and applied receipt;
Appearance must not promise Finder recolouring or request a writable install.
Release verification must pass `codesign --verify --deep --strict` before and
after launch and theme changes. Do not strip user metadata during launch;
reinstall the clean app to replace a legacy bundle carrying a custom Finder icon.

With native glass active, New note and its generation chevron share one light
rim and translucent surface that exposes the existing AppKit material. Keep
the text opaque, the chevron separator inset, and solid styling when glass is
off or accessibility requests reduced transparency/increased contrast. The
control follows the shared glass tint with a small additional 12% surface tint
to remain slightly more opaque than its surroundings. It adds no appearance
setting or native material view. Compact sidebars stack the two actions inside
one outline. Gate this treatment on `data-native-glass`, whose native response
already handles accessibility; unsupported positive transparency media queries
must not suppress the treatment in WKWebView.
Selected navigation pills and the open/hovered Space switcher use the same
translucent treatment. Generate and Space dropdowns use a stronger bounded tint
derived from shared glass opacity, with a web backdrop blur to keep underlying
navigation from showing through their text. This is a renderer popover over the
existing AppKit frame, not an independent native glass view. Their selected rows
and New blank space control stay translucent; all overrides require native glass.
Keep these fills uniform and translucent: do not paint gradients or simulated
diagonal highlights onto the controls or popovers. Popover tint tracks the shared
setting plus 12 percentage points, bounded to 24–92% for readable content.

Typography uses two deliberate brand roles: bundled Hanken Grotesk (400) for the
interface and default note text; bundled Lora (400) for the Home headline and
its supporting paragraph, plus note titles on Home, Notes, and the open note.
Small navigation uses Hanken Grotesk 400 and
controls keep stronger weights for readability. The editor toolbar’s Note font
dropdown owns the shared Sans serif / Serif choice; do not place it in Settings.
`Settings.noteTypeface` accepts
only `sans` or `serif`, is optional at the storage boundary, and hydrates to
`sans`; the app-shell attribute applies it to reading and rich editing without
changing persisted prose. Do not add a font catalogue or use serif type for
ordinary UI headings. `public/fonts` contains the four unmodified variable TTF
faces (Hanken Grotesk 100–900, Lora 400–700, upright and real italic), their OFL copyright
and licence texts, and pinned source/checksum metadata. Keep these assets local
and preserve their licences in renderer builds; do not fetch fonts at runtime.
`src/App.css` defines the faces and `index.html` preloads the upright fonts.
See `docs/typography.md` for font roles and the reading scale.
Primary navigation and sidebar notes are 13 px, note text is 18 px sans / 19 px serif, and the
Space overview uses a 22 px heading and 13 px body text in a 460 px tall card; the body matches the task empty state. Keep the adjacent
task card aligned at that height, with both bodies independently scrollable.

Selected sidebar notes use the full-row background highlight without a decorative
outline on the inner note button. Preserve keyboard focus-visible outlines.

Keep the sidebar footer anchored at the bottom in both expanded and compact
layouts. Expanded sidebars place the collapse toggle first and Settings beside
it. Compact rails stack Settings above the sidebar toggle, with no divider
above those bottom controls. The navigation
divider stays below Chat; hiding the note list must not pull the footer upward.

Orion should feel calm, editorial, and spatial rather than dashboard-heavy.
Reuse the existing colors, surfaces, typography, radii, and compact scale in
`App.css`. Prefer a single clear action and progressive disclosure. Preserve:

- direct editing with the animated toolbar;
- note dictation in that sticky toolbar, with the body insertion point preserved
  and mapped through edits while on-device transcription is running;
- one contextual toolbar at the original width around a restrained reading
  measure. Its main controls switch between text, selected-image and table actions while keeping
  the current object selected. Lower-priority tools move into a bounded
  contextual More menu as width narrows; no toolbar region scrolls horizontally.
  More stays at the far right after the fixed Undo/Redo group. Menus use fixed
  icon and text columns. Preserve portable Markdown controls
  for strikethrough, inline and fenced code, dividers, tasks and editable tables;
- source citations are ordinary Markdown links using the private
  `orion-source://<id>` protocol. The citation picker may attach any source in
  the current Space, updates both sides of note/source provenance atomically,
  and inserts compact numbers ordered by first appearance. Persisted/exported
  Markdown includes a canonical trailing `## References` list, but the editor
  strips that generated block from `contenteditable` and renders it as a
  read-only footer so it is always last and cannot move the caret. Repeated
  citations reuse one number and reference entry. Inline numbers and footer
  titles open the preserved Source viewer. Deleting a source removes numeric
  markers entirely, retains descriptive prose from legacy citation links, and
  renumbers the remaining references;
- `noteCodeSerialization.ts` preserves literal code through the instance-scoped
  `NoteMarkdown` serializer wrapper. Work on a transient JSON copy; collision-free
  placeholders must be restored before returning Markdown, never persisted.
  Derive inline/fenced delimiters from real content and protect code spacing
  from general mark/table trimming. Ordinary table pipes need correct escaping.
  An odd backslash run before a table-code pipe uses adjacent code spans joined
  by exactly `<!-- orion-code-join -->`; only the matching inline-code triple
  inside a table is merged by reading/export. Literal comments, other comments
  and comments outside that shape remain untouched. Keep three-reopen and
  reading/export equivalence checks. Inline line endings follow CommonMark;
  use fenced code for literal newlines. Do not patch Tiptap globals/node_modules,
  mutate editor state while saving or introduce an autosave exception for
  ordinary code typing;
- note-local Find in reading and editing modes through the header control and
  `Cmd/Ctrl+F`, with wrapping previous/next navigation and no mutation of note
  content; closing Find must preserve the current reading position and restore
  focus with `preventScroll`;
- a gradient-free writing surface, with to-do list formatting in the same
  toolbar and a scrollable Home To-dos section replacing the redundant
  lower Import Studio card; task rows are plain, proportionate typography beside
  the checkbox, without colored text containers or nested card surfaces; use the
  blue/periwinkle Orion checkbox in every state, and keep task spacing visually
  identical between the editing and reading surfaces;
- Home's content-driven To-dos/Tickets sections above recent notes, followed by
  the full-width, scrollable living Space overview. Unused work sections stay
  absent; narrow boards stack their columns. Task text and overview headlines wrap naturally instead
  of truncating; the overview is a first-class optional Space field, keeps its
  previous text visible during refresh, becomes stale whenever substantive
  knowledge changes, rejects late results against a knowledge fingerprint, and
  has a deterministic local fallback without an API key;
- card hover glow follows the perimeter nearest the pointer as a soft luminous
  edge and halo; never replace it with a radial spotlight beneath the pointer or
  reveal a persistent solid outline; both edge and halo must inherit the exact
  card radius without square filter bleed at the corners;
- a persisted, reduced-motion-safe home atmosphere chosen from Mirage, Signal
  Decay, Field, Line Waves, Opal, and Ripple Glass, with curated or custom accent
  and motion controls; only the active renderer should load or animate. Mirage,
  Opal and Ripple Glass share a local WebGL lifecycle with no external artwork
  or shader dependency, a 600,000-pixel budget and 30 fps cap, hidden/offscreen
  suspension, static fallbacks, and context-loss recovery. Still draws only on
  resize or pointer input; system reduced motion also disables pointer response.
  Mirage occupies the whole hero rather than a central object. The retired
  effects (Quiet Loom, Nova, Flux, Tidal Glass, Prism Drift, Nebula, Emberwake,
  Gravity Silk) remain on disk but are never offered or imported; see Persisted
  appearance settings above for how their saved IDs hydrate;
- direct canonical article navigation, with the right-hand connections canvas
  reserved for unresolved legacy ambiguity instead of a graph;
- route-aware Back/Forward: a note opened from Notes returns to Notes, a note
  opened from Home returns to Home, direct destinations open at the top, and
  history traversal restores the exact saved scroll position;
- a dedicated Favorites section above one complete active-Space sidebar note
  list, both preserving the stored note-array order when notes are opened;
  favorites remain in All notes so that list is genuinely complete;
- a scrollable left-hand outline derived from H1–H6 Markdown, with stable
  duplicate-safe anchors, an editorial reading scale, and the current section
  emphasized as the user reads, including the final section at scroll end.
  The note title remains separate, the heading picker previews all six levels,
  and deeper headings remain legible. Never reserve the outline grid column
  when no outline exists, and hide the rail only where the window cannot support it;
- note sources, backlinks, and related notes in an on-demand right-hand
  connections inspector that overlays the reading canvas rather than
  permanently shrinking it. Source entries open the preserved text or
  transcript, metadata, original URL when available, and the notes it shaped;
- no reference-hover popovers on automatic or explicit concept links;
- strong empty states with no fake content;
- keyboard access, focus trapping, visible focus, reduced-motion behavior, and
  useful ARIA labels;
- draggable native window chrome across the full top bar, including the blank
  sidebar strip and gaps around controls. The top bar uses Tauri's `deep` drag
  region so non-interactive descendants participate; buttons and other controls
  retain normal input. The Space switcher stays above the sidebar drag strip in
  stacking order so its entire button remains clickable;
- Chat uses one continuous background behind the thread and composer; do not
  add a composer-width backdrop that creates vertical seams across that room;
- one calm Share or export sheet whose default is an offline web article, with
  explicit format and scope choices plus a plain privacy summary; do not turn
  export into a settings dashboard or imply that a local file is already a
  hosted public URL;
- desktop layouts down to the configured 1024×680 minimum, plus responsive
  browser-preview layouts.

Do not introduce a separate Markdown editor, read/write tabs, a Link Lens button,
or a persistent import button floating over unrelated screens.

## Sidebar navigation sizing and Chat mark

Collapsed and responsive icon-only navigation gives `.sidebar-nav-row` an explicit
44 px width. Preserve this wrapper width: the voice stylesheet sets its child to
100%, and an intrinsic wrapper shrinks the selected background to the icon.
`ChatVoiceMark.tsx` uses the user-supplied Group 3-4 SVG with currentColor for the idle
Chat icon, including SidebarVoiceIndicator. Its square 19-unit viewBox centres
the artwork within the existing 22px-wide slot, without altering the paths. The combined mark is the single Chat entry; do not add a separate sidebar voice
button. Start voice through the existing Chat composer. Chat uses the same row
width as the other navigation entries; active calls still show the constellation.
