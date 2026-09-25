# Typography

## Roles

- Hanken Grotesk (weight 400): navigation, controls, labels, settings, Chat, note summaries, Space overview, and default note text.
- Lora (weight 400): the Home headline “Everything you know, in context.” and its supporting paragraph, note card titles on Home and Notes, and the open note title.
- Note text: one shared Sans serif / Serif preference in the note editor toolbar’s **Note font** dropdown. Sans serif is the default. The preference applies to reading and rich-text editing; code remains monospace.

`noteTypeface` is optional for older vaults and defaults to `sans` through existing hydration. Only `sans` and `serif` are valid persisted values. The setting does not change Markdown or note timestamps.

## Reading scale

Primary navigation and sidebar notes are 13 px; the Space name is 14 px and sidebar metadata is 11 px. Shared controls outside the sidebar remain 14 px. Secondary labels are generally 11–13 px. Home and Notes card titles are 22–23 px with 15 px summaries. Note text is 18 px / 1.7 sans or 19 px / 1.75 serif; Chat is 17 px.

Home’s Space overview and adjacent task card are 460 px tall. The overview uses a 22 px / 1.25 heading at weight 560, 13 px / 1.45 body, 12 px status, and 28 px padding. The overview body matches the “Nothing waiting” task empty state body size; its title has a stronger hierarchy. Both cards keep independently scrollable bodies and stack at the existing narrow breakpoint. Long overview titles wrap; text is never truncated to fit the card. The body uses the stronger reading foreground instead of muted metadata colour.

## Bundled fonts

Orion bundles unmodified Hanken Grotesk and Lora variable TTF files from the official Google Fonts repository under `public/fonts`. Hanken Grotesk supports weights 100–900 and Lora 400–700, with separate real italic files for both. CSS declares those ranges and disables synthetic faces.

Hanken Grotesk Regular (400) is the default prose weight. Primary navigation and sidebar note labels use 400 for small-size clarity; controls and labels retain stronger hierarchy where needed. Lora titles, the Home headline and supporting paragraph, and optional serif prose use 400. Semantic bold text uses 700; italics load the matching italic font.

`src/App.css` loads the four local files with `@font-face`; `index.html` preloads the two upright faces. No external font requests or system font installation are required. The Sans serif / Serif preference controls both reading and editing and preserves the existing larger sizes and taller overview.

The original copyright and SIL Open Font License texts are included beside the fonts as `HankenGrotesk-OFL.txt` and `Lora-OFL.txt`, and are copied into the renderer build. `public/fonts/sources.json` records the pinned upstream commit, exact download URLs, and SHA-256 checksums. Preserve these notices when distributing Orion.

Official sources:

- https://fonts.google.com/specimen/Hanken+Grotesk
- https://github.com/google/fonts/tree/main/ofl/hankengrotesk
- https://github.com/google/fonts/tree/main/ofl/lora
