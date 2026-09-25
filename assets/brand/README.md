# Orion Imprint icon

`orion-imprint.png` is the wordmark-free teal/cobalt icon selected for Orion on
2026-09-25. It was edited from the user's approved logo with the built-in image
generation tool. The exact edit prompt is in `imprint-edit-prompt.txt`.

The 1254 × 1254 RGBA master includes a dark teal rounded tile and transparent
outside corners. It remains in use for startup/favicon and plugin artwork;
the sidebar now uses the separate transparent symbol below.

## Sidebar symbol

The sidebar uses `orion-imprint-symbol.png`, a freestanding O extracted with the
built-in image tool using `imprint-symbol-edit-prompt.txt`. Both the outside and
central hole are transparent. `public/orion-symbol.png` is its 256 px export.
`public/orion-symbol-source.png` is an unchanged copy of the full-resolution
master for runtime theme colouring. The renderer maps its luminance into a
theme-derived shadow/body/highlight palette and keeps its alpha exactly intact.
The result remains transparent in the sidebar; native Dock/Finder presentation
uses a separate rounded tile with a uniform theme surface colour. Original
removes the Finder custom icon and restores the packaged artwork.
The sidebar displays this without a background tile. Export with:

```sh
sips -z 256 256 assets/brand/orion-imprint-symbol.png --out public/orion-symbol.png
```

## Native icon

`orion-imprint-native.png` is the separate 1254 × 1254 RGB, fully opaque,
full-bleed master for the operating system. The built-in image tool extended
only the background; its prompt is in `imprint-native-edit-prompt.txt`.
The native background reaches all four square edges. macOS supplies its final
mask and presentation. The rounded RGBA renderer master must not be used here:
macOS renders its transparent/inset tile inside an unwanted white surround.

Generate native exports with the installed Tauri CLI:

```sh
./node_modules/.bin/tauri icon assets/brand/orion-imprint-native.png -o /private/tmp/orion-imprint-icons
```

Copy the generated top-level PNG, ICO and ICNS files to `src-tauri/icons/`.
The Claude connector takes its icon from `src-tauri/icons/icon.png`.

`public/orion-mark.png` and `codex/orion/assets/icon.png` keep their existing
256 px and 512 px rounded renderer-master exports. Do not replace them with
the square native artwork. The release scripts rebuild both bundled connectors
from their respective source assets.

The correction was checked through AppKit's `NSWorkspace.icon(forFile:)` at
512 px on macOS 27, reproducing the white surround with the old ICNS and
confirming its absence with the opaque native ICNS. Native before/after renders
are in `outputs/icon-fix-verification-2026-09-25/`.

Legacy SVG files are retained as earlier artwork; application and plugin
identity references use these PNG/ICNS exports.
