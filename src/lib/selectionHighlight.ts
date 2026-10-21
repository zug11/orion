const NAME = "orion-selected-passage";
type Registry = { set(name: string, value: unknown): void; get(name: string): unknown; delete(name: string): void };

/** Paint a captured passage without moving the native selection or the typing
 * cursor. Nothing is inserted into the editor's document or saved Markdown. */
export function createSelectionHighlight() {
  let dispose = () => {};
  const clear = () => { dispose(); dispose = () => {}; };
  return {
    clear,
    show(source: Range, root: HTMLElement) {
      clear();
      const range = source.cloneRange();
      const registry = (globalThis.CSS as typeof CSS & { highlights?: Registry } | undefined)?.highlights;
      const Highlight = (globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
      if (registry && Highlight) {
        const highlight = new Highlight(range);
        registry.set(NAME, highlight);
        dispose = () => { if (registry.get(NAME) === highlight) registry.delete(NAME); };
        return;
      }
      // Older WebKit: an inert, viewport-clipped paint layer, never wrapper
      // spans inside contenteditable or a forced browser selection.
      const layer = document.createElement("div");
      layer.className = "orion-selection-highlight"; layer.setAttribute("aria-hidden", "true");
      (root.closest(".app-shell, [data-theme]") ?? document.body).append(layer);
      let frame = 0;
      const paint = () => {
        frame = 0;
        layer.replaceChildren();
        if (!root.isConnected) return;
        const bounds = root.getBoundingClientRect();
        const rects = [...(range.getClientRects?.() ?? [])].filter(rect => rect.width && rect.height && rect.bottom > 0 && rect.top < window.innerHeight).slice(0, 256);
        for (const rect of rects) {
          const left = Math.max(0, rect.left, bounds.left), right = Math.min(window.innerWidth, rect.right, bounds.right);
          const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
          if (right <= left || bottom <= top) continue;
          const mark = document.createElement("i");
          Object.assign(mark.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
          layer.append(mark);
        }
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
      paint();
      window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
      dispose = () => { cancelAnimationFrame(frame); layer.remove(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
    },
  };
}
