# Orion Frames — design preview

Orion Frames is a visual-only animated SVG proposal for review. It is not wired
into the Orion application and no reusable app components are included. The icons use a
24 × 24 optical grid, 1.65 px rounded strokes, open celestial geometry, and a
small asymmetrical detail so they feel drawn for Orion rather than borrowed
from a generic interface library.

The pack currently includes:

- `Mark`, `Atlas`, `Articles`, `Sources`, `Chat`, and `Space`
- `NewNote`, `Import`, `Concept`, `Link`, and `Search`
- `Controls`, `Export`, `Context`, and `Send`

## Preview motion

The standalone gallery contains animation frames for review. Motion
describes the action: pages open, a link closes, a download lands, control knobs
move, and Orion's belt resolves into place. Icons stay still until their parent
button or link is hovered or keyboard-focused.

Open `preview.html` to review the whole pack and hover or keyboard-focus each
tile to play its frames.

This folder is a design artifact only. Do not import it from `src/` unless the
icon direction is explicitly approved later.
