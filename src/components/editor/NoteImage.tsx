import Image from "@tiptap/extension-image";
import type { Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { isSafeNoteImageUrl } from "../../lib/noteImages";
import {
  defaultNoteImageLayout,
  escapeNoteImageMarkdownText,
  normalizeNoteImageLayout,
  noteImageContentCss,
  noteImageContentStyle,
  noteImageLayoutCss,
  parseNoteImageTitle,
  serializeNoteImageTitle,
  type NoteImageAlignment,
  type NoteImageLayout,
} from "../../lib/noteImageLayout";
import "./NoteImage.css";

type ImageDragExclusion = { position: number; element: HTMLElement; key: string };
export const noteImageDragKey = new PluginKey<ImageDragExclusion | null>("noteImageDrag");
let imageDragSequence = 0;

function setImageDragExclusion(editor: Editor, value: ImageDragExclusion | null) {
  if (editor.isDestroyed) return;
  const previous = noteImageDragKey.getState(editor.state);
  if (previous === value || (!previous && !value)
    || (previous && value && previous.position === value.position && previous.element === value.element)) return;
  editor.view.dispatch(editor.state.tr.setMeta(noteImageDragKey, value).setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
}

function commitLayout(editor: Editor, position: number, changes: Partial<NoteImageLayout>) {
  const node = editor.state.doc.nodeAt(position);
  if (!node || node.type.name !== "image" || !editor.isEditable) return;
  const attrs = { ...node.attrs, ...normalizeNoteImageLayout({ ...node.attrs, ...changes }) };
  if (Object.entries(attrs).every(([key, value]) => value === node.attrs[key])) return;
  const tr = closeHistory(editor.state.tr).setNodeMarkup(position, undefined, attrs);
  tr.setSelection(NodeSelection.create(tr.doc, position));
  editor.view.dispatch(tr);
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
}

export function updateSelectedNoteImage(editor: Editor, changes: Partial<NoteImageLayout>) {
  const selection = editor.state.selection;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") return false;
  commitLayout(editor, selection.from, changes);
  return true;
}

/** A pointer drop moves the existing image, never a copy reconstructed from its URL. */
export function moveNoteImage(editor: Editor, source: number, target: number,
  placement?: NoteImageAlignment | Pick<NoteImageLayout, "xPercent" | "offsetY" | "placement">) {
  if (editor.isDestroyed || !editor.isEditable || !Number.isInteger(source) || !Number.isInteger(target)
    || source < 0 || source > editor.state.doc.content.size || target < 0 || target > editor.state.doc.content.size) return false;
  const original = editor.state.doc.nodeAt(source);
  // Drops are deliberately anchored between document blocks, not inside prose.
  if (!original || original.type.name !== "image" || editor.state.doc.resolve(target).depth !== 0) return false;
  const layout = normalizeNoteImageLayout({ ...original.attrs,
    ...(typeof placement === "string" ? { alignment: placement, xPercent: null, offsetY: 0 } : placement) });
  if (layout.xPercent === null && layout.alignment === "center" && layout.placement === "wrap") layout.placement = "break";
  const moved = original.type.create({ ...original.attrs, ...layout }, original.content, original.marks);
  const tr = closeHistory(editor.state.tr).delete(source, source + original.nodeSize);
  const insertion = tr.mapping.map(target);
  tr.insert(insertion, moved);
  if (tr.doc.eq(editor.state.doc)) return false;
  tr.setSelection(NodeSelection.create(tr.doc, insertion));
  editor.view.dispatch(tr.setMeta("uiEvent", "drop"));
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
  editor.view.focus();
  return true;
}

/** Keep the ordinary `image` name used by uploads, AI acceptance and Markdown. */
export const NoteImage = Image.extend({
  // WebKit's native node drag can capture the natural-size bitmap and its
  // selection rectangle. Image movement is handled by an actual-size pointer UI.
  draggable: false,
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), new Plugin<ImageDragExclusion | null>({
      key: noteImageDragKey,
      state: {
        init: () => null,
        apply: (transaction, previous) => {
          // A concurrent edit invalidates the captured source and drop anchor.
          // Remove its temporary layout before that changed document is drawn.
          if (transaction.docChanged) return null;
          const next = transaction.getMeta(noteImageDragKey) as ImageDragExclusion | null | undefined;
          return next === undefined ? previous : next;
        },
      },
      props: {
        decorations: (state) => {
          const current = noteImageDragKey.getState(state);
          return current ? DecorationSet.create(state.doc, [Decoration.widget(current.position, () => current.element, {
            key: current.key, side: -1, ignoreSelection: true, stopEvent: () => true,
          })]) : DecorationSet.empty;
        },
      },
    })];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => parseNoteImageTitle(element.getAttribute("title")).title,
      },
      ...Object.fromEntries(Object.entries(defaultNoteImageLayout).map(([name, value]) => [name, {
        default: value,
        rendered: false,
        parseHTML: (element: HTMLElement) => parseNoteImageTitle(element.getAttribute("title")).layout[name as keyof NoteImageLayout],
      }])),
    };
  },
  parseHTML() {
    return [{
      tag: "img[src]",
      getAttrs: (element) => {
        const parsed = parseNoteImageTitle((element as HTMLElement).getAttribute("title"));
        return { ...parsed.layout, title: parsed.title };
      },
    }];
  },
  renderHTML({ node }) {
    const src = typeof node.attrs.src === "string" && isSafeNoteImageUrl(node.attrs.src) ? node.attrs.src : undefined;
    return ["img", {
      src,
      alt: node.attrs.alt || "",
      title: serializeNoteImageTitle(node.attrs, node.attrs.title),
      class: "note-embedded-image",
    }];
  },
  parseMarkdown(token, helpers) {
    const parsed = parseNoteImageTitle(token.title);
    return helpers.createNode("image", {
      src: token.href,
      alt: token.text,
      title: parsed.title,
      ...parsed.layout,
    });
  },
  renderMarkdown(node) {
    const title = serializeNoteImageTitle(node.attrs, node.attrs?.title);
    const alt = escapeNoteImageMarkdownText(node.attrs?.alt);
    const src = String(node.attrs?.src ?? "").replace(/[\r\n]/g, "");
    return `![${alt}](${src}${title ? ` "${escapeNoteImageMarkdownText(title)}"` : ""})`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(NoteImageView, {
      className: "orion-note-image-node",
      attrs: ({ node }) => ({
        style: noteImageLayoutCss(node.attrs),
        "data-placement": normalizeNoteImageLayout(node.attrs).placement,
        "data-alignment": normalizeNoteImageLayout(node.attrs).alignment,
      }),
    });
  },
});

function NoteImageView({ node, editor, selected, getPos }: NodeViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const layout = normalizeNoteImageLayout(node.attrs);
  const [caption, setCaption] = useState(layout.caption);
  const [resizing, setResizing] = useState(false);
  const cancelResizeRef = useRef<(() => void) | null>(null);
  const cancelMoveRef = useRef<(() => void) | null>(null);
  useEffect(() => setCaption(layout.caption), [layout.caption]);
  useEffect(() => {
    const element = captionRef.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(160, element.scrollHeight)}px`;
    }
  }, [caption, layout.showCaption, layout.widthPercent]);
  useEffect(() => () => { cancelResizeRef.current?.(); cancelMoveRef.current?.(); }, []);

  function position() {
    const current = getPos();
    return typeof current === "number" ? current : null;
  }
  function select() {
    const pos = position();
    if (pos !== null && editor.isEditable) editor.chain().focus().setNodeSelection(pos).run();
  }
  function saveCaption() {
    const pos = position();
    if (pos !== null && caption !== layout.caption) commitLayout(editor, pos, { caption });
  }
  function beginMove(event: PointerEvent<HTMLDivElement>) {
    if (!editor.isEditable || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    cancelMoveRef.current?.();
    const sourcePosition = position();
    const visual = event.currentTarget;
    const outer = wrapperRef.current?.closest<HTMLElement>(".orion-note-image-node");
    const root = editor.view.dom;
    const shell = root.closest<HTMLElement>(".app-shell") ?? root.parentElement;
    if (sourcePosition === null || !shell || !outer) return;
    const source = sourcePosition;
    editor.commands.setNodeSelection(source);
    editor.view.focus();
    const scroller = root.closest<HTMLElement>(".workspace-content");
    const imageRect = visual.getBoundingClientRect();
    if (imageRect.width <= 0 || imageRect.height <= 0) return;
    const figureHeight = wrapperRef.current?.getBoundingClientRect().height ?? imageRect.height;
    const originalOuterStyle = outer.style.cssText;
    const originalMinHeight = root.style.minHeight;
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let point = { ...start };
    let dragging = false;
    let frame = 0;
    let preview: HTMLDivElement | null = null;
    let clipLayer: HTMLDivElement | null = null;
    let exclusion: HTMLDivElement | null = null;
    const exclusionKey = `image-drag-${++imageDragSequence}`;
    let lastPlacement = "";
    let target: { position: number; xPercent: number; offsetY: number } | null = null;
    const originalDocument = editor.state.doc;
    const contentBounds = () => {
      const rect = root.getBoundingClientRect(), style = getComputedStyle(root);
      const left = rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth || "0");
      const right = rect.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth || "0");
      return { left, right, width: right - left, top: rect.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth || "0") };
    };
    const originalContentWidth = contentBounds().width;
    const viewport = () => {
      const rect = scroller?.getBoundingClientRect();
      const toolbar = root.closest(".rich-note-editor")?.querySelector(".editor-toolbar-shell")?.getBoundingClientRect();
      return {
        left: Math.max(0, rect?.left ?? 0), right: Math.min(window.innerWidth, rect?.right ?? window.innerWidth),
        top: Math.max(0, rect?.top ?? 0, toolbar && toolbar.top <= (rect?.top ?? 0) + 24 ? toolbar.bottom + 8 : 0),
        bottom: Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight),
      };
    };
    function place() {
      if (!preview || !clipLayer || editor.isDestroyed) return;
      const bounds = contentBounds();
      if (Math.abs(bounds.width - originalContentWidth) > 0.5 || editor.state.doc !== originalDocument
        || window.innerWidth !== originalViewport.width || window.innerHeight !== originalViewport.height) { cancel(); return; }
      const clip = viewport();
      const placementSignature = [point.x, point.y, bounds.left, bounds.top, clip.left, clip.right,
        clip.top, clip.bottom, root.scrollHeight, scroller?.scrollTop].join(":");
      if (lastPlacement === placementSignature) return;
      lastPlacement = placementSignature;
      clipLayer.style.left = `${clip.left}px`;
      clipLayer.style.top = `${clip.top}px`;
      clipLayer.style.width = `${clip.right - clip.left}px`;
      clipLayer.style.height = `${clip.bottom - clip.top}px`;
      // Clip the presentation at the writing viewport instead of shrinking it
      // or pulling the pointer grip away from the position being requested.
      preview.style.left = `${imageRect.left + point.x - start.x - clip.left}px`;
      preview.style.top = `${imageRect.top + point.y - start.y - clip.top}px`;
      target = null;
      if (point.x < clip.left || point.x > clip.right || point.y < clip.top || point.y > clip.bottom) {
        if (noteImageDragKey.getState(editor.state)?.element === exclusion) setImageDragExclusion(editor, null);
        return;
      }
      const left = Math.max(bounds.left, Math.min(imageRect.left + point.x - start.x, bounds.right - imageRect.width));
      const desiredTop = Math.max(bounds.top + layout.gap, imageRect.top + point.y - start.y);
      // Measure the unobstructed baseline synchronously, without changing prose
      // DOM. Otherwise the temporary wrapping would move its own next anchor.
      let anchor = { position: 0, top: bounds.top };
      let clearFloor = bounds.top;
      root.style.minHeight = `${Math.max(parseFloat(root.style.minHeight) || 0, root.getBoundingClientRect().height)}px`;
      const exclusionDisplay = exclusion?.style.display;
      if (exclusion) exclusion.style.display = "none";
      try {
        editor.state.doc.forEach((block, pos) => {
          if (pos === source) return;
          const element = editor.view.nodeDOM(pos);
          if (!(element instanceof HTMLElement)) return;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (style.float !== "none") {
            clearFloor = Math.max(clearFloor, rect.bottom + (parseFloat(style.marginBottom) || 0));
            return;
          }
          const top = Math.max(clearFloor, rect.top);
          if (block.type.name === "paragraph" && top + layout.gap <= desiredTop && top >= anchor.top) anchor = { position: pos, top };
        });
      } finally { if (exclusion) exclusion.style.display = exclusionDisplay ?? ""; }
      const next = normalizeNoteImageLayout({ ...layout, xPercent: (left - bounds.left) / bounds.width * 100,
        offsetY: desiredTop - anchor.top - layout.gap, placement: layout.placement === "inline" ? "wrap" : layout.placement });
      target = { position: anchor.position, xPercent: next.xPercent!, offsetY: next.offsetY };
      if (exclusion) {
        // This DOM belongs to the ProseMirror widget, not to the editable prose.
        // Same-anchor movement needs no transaction or document-wide link scan.
        exclusion.style.cssText = noteImageLayoutCss(next);
        const content = exclusion.firstElementChild as HTMLElement;
        content.style.cssText = `${noteImageContentCss(next)};height:${figureHeight}px;pointer-events:none`;
        setImageDragExclusion(editor, { position: anchor.position, element: exclusion, key: exclusionKey });
        const actual = content.getBoundingClientRect();
        preview.style.left = `${actual.left - clip.left}px`;
        preview.style.top = `${actual.top - clip.top}px`;
      }
    }
    function tick() {
      if (!dragging || editor.isDestroyed) return;
      if (scroller) {
        const clip = viewport();
        if (point.x >= clip.left && point.x <= clip.right && point.y >= clip.top && point.y <= clip.bottom) {
          const edge = 64;
          const delta = point.y < clip.top + edge ? -Math.ceil((clip.top + edge - point.y) / 5)
            : point.y > clip.bottom - edge ? Math.ceil((point.y - clip.bottom + edge) / 5) : 0;
          if (delta) scroller.scrollTop += delta;
        }
      }
      place();
      if (dragging) frame = window.requestAnimationFrame(tick);
    }
    function startDrag() {
      dragging = true;
      shell!.classList.add("is-image-dragging");
      // Reserve the current document height so lifting a large image near the
      // end cannot clamp scrollTop and move the pointer's document coordinates.
      root.style.minHeight = `${root.getBoundingClientRect().height}px`;
      exclusion = document.createElement("div");
      exclusion.className = "note-image-drag-exclusion";
      exclusion.contentEditable = "false";
      exclusion.setAttribute("aria-hidden", "true");
      exclusion.append(document.createElement("div"));
      preview = document.createElement("div");
      preview.className = "note-image-drag-preview";
      preview.setAttribute("aria-hidden", "true");
      preview.style.width = `${imageRect.width}px`;
      preview.style.height = `${figureHeight}px`;
      const image = visual.querySelector("img");
      if (image) {
        const copy = image.cloneNode(false) as HTMLImageElement;
        copy.removeAttribute("title"); copy.alt = ""; copy.draggable = false;
        copy.style.height = `${imageRect.height}px`;
        preview.append(copy);
      } else {
        const unavailable = visual.querySelector(".note-image-unavailable");
        if (unavailable) {
          const copy = unavailable.cloneNode(true) as HTMLDivElement;
          copy.style.height = `${imageRect.height}px`;
          preview.append(copy);
        }
      }
      const captionElement = captionRef.current;
      const captionScrollTop = captionElement?.scrollTop ?? 0;
      if (captionElement) {
        const copy = captionElement.cloneNode(false) as HTMLTextAreaElement;
        copy.value = captionElement.value;
        copy.readOnly = true;
        copy.tabIndex = -1;
        copy.removeAttribute("aria-label");
        copy.style.height = `${captionElement.getBoundingClientRect().height}px`;
        preview.append(copy);
      }
      clipLayer = document.createElement("div");
      clipLayer.className = "note-image-drag-viewport";
      clipLayer.setAttribute("aria-hidden", "true");
      clipLayer.append(preview);
      outer!.style.display = "none";
      shell!.append(clipLayer);
      const copiedCaption = preview.querySelector("textarea");
      if (copiedCaption) copiedCaption.scrollTop = captionScrollTop;
      place();
      if (dragging) frame = window.requestAnimationFrame(tick);
    }
    function move(moveEvent: globalThis.PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!dragging && Math.hypot(point.x - start.x, point.y - start.y) >= 6) startDrag();
    }
    function cleanup(keepReservation = false) {
      dragging = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("keydown", keydown, true);
      clipLayer?.remove();
      if (noteImageDragKey.getState(editor.state)?.element === exclusion) setImageDragExclusion(editor, null);
      const livePosition = editor.isDestroyed ? null : position();
      const liveNode = livePosition === null ? null : editor.state.doc.nodeAt(livePosition);
      if (outer!.isConnected) outer!.style.cssText = liveNode?.type.name === "image"
        ? noteImageLayoutCss(liveNode.attrs) : originalOuterStyle;
      if (!keepReservation) root.style.minHeight = originalMinHeight;
      shell!.classList.remove("is-image-dragging");
      cancelMoveRef.current = null;
    }
    function cancel() { cleanup(); }
    function keydown(keyEvent: globalThis.KeyboardEvent) {
      if (keyEvent.key === "Escape") {keyEvent.preventDefault();keyEvent.stopPropagation();cancel();}
    }
    function finish(upEvent: globalThis.PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      point = { x: upEvent.clientX, y: upEvent.clientY };
      if (dragging) place();
      const destination = target;
      const wasDragging = dragging;
      cleanup(true);
      // Abort if another edit changed the document during the gesture. Never
      // move whatever happens to occupy the original position after an edit.
      try {
        if (wasDragging && destination && editor.state.doc === originalDocument) {
          moveNoteImage(editor, source, destination.position, {
            xPercent: destination.xPercent, offsetY: destination.offsetY,
            placement: layout.placement === "inline" ? "wrap" : layout.placement,
          });
        }
      } finally { root.style.minHeight = originalMinHeight; }
    }
    cancelMoveRef.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("keydown", keydown, true);
  }
  function beginResize(event: PointerEvent<HTMLButtonElement>, corner: string) {
    if (!editor.isEditable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    select();
    const outer = wrapperRef.current?.closest<HTMLElement>(".orion-note-image-node");
    const parent = outer?.parentElement;
    if (!outer || !parent) return;
    const content = wrapperRef.current!;
    const width = content.getBoundingClientRect().width;
    const height = wrapperRef.current?.querySelector(".note-image-visual")?.getBoundingClientRect().height || width;
    const parentStyle = getComputedStyle(parent);
    const parentWidth = parent.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight);
    const x = event.clientX;
    const y = event.clientY;
    let next = layout;
    const applyPreview = (value: NoteImageLayout) => {
      outer!.style.cssText = noteImageLayoutCss(value);
      content.style.cssText = noteImageContentCss(value);
    };
    setResizing(true);
    function move(moveEvent: globalThis.PointerEvent) {
      const horizontal = (moveEvent.clientX - x) * (corner.endsWith("right") ? 1 : -1);
      const vertical = (moveEvent.clientY - y) * (corner.startsWith("bottom") ? 1 : -1) * width / height;
      const delta = Math.abs(horizontal) > Math.abs(vertical) ? horizontal : vertical;
      const west = corner.endsWith("left");
      const right = (layout.xPercent ?? 0) + layout.widthPercent;
      const maximum = layout.xPercent === null ? 100 : west ? right : 100 - layout.xPercent;
      const widthPercent = Math.max(15, Math.min(maximum, (width + delta) / parentWidth * 100));
      const xPercent = layout.xPercent === null ? null : west ? right - widthPercent : layout.xPercent;
      const offsetY = layout.xPercent !== null && corner.startsWith("top")
        ? Math.max(0, layout.offsetY - (widthPercent - layout.widthPercent) / 100 * parentWidth * height / width) : layout.offsetY;
      next = normalizeNoteImageLayout({ ...layout, widthPercent, xPercent, offsetY });
      applyPreview(next);
    }
    function cleanup() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      cancelResizeRef.current = null;
    }
    function finish() {
      cleanup();
      setResizing(false);
      const pos = position();
      applyPreview(layout);
      if (pos !== null) commitLayout(editor, pos, next);
    }
    function cancel() {
      cleanup();
      applyPreview(layout);
      setResizing(false);
    }
    cancelResizeRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  }
  function resizeByKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    const pos = position();
    if (pos !== null) commitLayout(editor, pos, { widthPercent: Math.min(100 - (layout.xPercent ?? 0), layout.widthPercent + direction * (event.shiftKey ? 10 : 2)) });
  }
  const safeSource = typeof node.attrs.src === "string" && isSafeNoteImageUrl(node.attrs.src);
  return (
    <NodeViewWrapper ref={wrapperRef} style={noteImageContentStyle(layout)} className={`note-image-view${layout.xPercent !== null ? " note-image-free-content" : ""}${selected ? " is-selected" : ""}${resizing ? " is-resizing" : ""}`} contentEditable={false}>
      <div className="note-image-visual" onPointerDown={beginMove} onMouseDown={(event) => event.preventDefault()}
        onDragStartCapture={(event) => { event.preventDefault(); event.stopPropagation(); }} draggable={false}>
        {safeSource
          ? <img src={node.attrs.src} alt={node.attrs.alt || ""} title={node.attrs.title || undefined} draggable={false} />
          : <div className="note-image-unavailable" role="img" aria-label={node.attrs.alt || "Image unavailable"}>Image unavailable</div>}
        {selected && editor.isEditable && (["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((corner) => (
          <button type="button" key={corner} className={`note-image-resize ${corner}`} title="Resize image · arrow keys adjust width" aria-label={`Resize image from ${corner.replace("-", " ")}`} onPointerDown={(event) => beginResize(event, corner)} onKeyDown={resizeByKeyboard} draggable={false} />
        ))}
      </div>
      {layout.showCaption && <textarea ref={captionRef} className="note-image-caption" aria-label="Image caption" placeholder="Add a caption…" rows={1} maxLength={500} value={caption} onChange={(event) => setCaption(event.target.value)} onBlur={saveCaption} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveCaption(); editor.commands.focus(); }
        if (event.key === "Escape") { event.preventDefault(); setCaption(layout.caption); editor.commands.focus(); }
      }} />}
    </NodeViewWrapper>
  );
}

export function ImageToolbar({ editor, overflowTarget }: { editor: Editor; overflowTarget?: HTMLElement|null }) {
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    active: !current.isDestroyed && current.isActive("image"),
    layout: normalizeNoteImageLayout(current.isDestroyed ? undefined : current.getAttributes("image")),
  }) });
  const [widthDraft, setWidthDraft] = useState(String(state.layout.widthPercent));
  const [moreOpen, setMoreOpen] = useState(false);
  const [openAbove, setOpenAbove] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  useEffect(() => setWidthDraft(String(state.layout.widthPercent)), [state.layout.widthPercent]);
  useEffect(() => {
    if (!moreOpen) return;
    const updatePlacement = () => {
      const rect = moreTrigger.current?.getBoundingClientRect();
      if (rect) setOpenAbove(window.innerHeight - rect.bottom < 210 && rect.top > window.innerHeight - rect.bottom);
    };
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    updatePlacement();
    moreRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("scroll", updatePlacement, true);
    window.addEventListener("resize", updatePlacement);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("scroll", updatePlacement, true);
      window.removeEventListener("resize", updatePlacement);
    };
  }, [moreOpen]);
  if (!state.active) return null;
  const { layout } = state;
  function change(value: Partial<NoteImageLayout>) { updateSelectedNoteImage(editor, value); }
  function saveWidth() {
    const parsed = Number(widthDraft);
    if (widthDraft && Number.isFinite(parsed)) change({ widthPercent: Math.min(100 - (layout.xPercent ?? 0), parsed) });
    else setWidthDraft(String(layout.widthPercent));
  }
  const moreControl = <div ref={moreRef} className="note-image-more" onKeyDown={(event) => {
    if (event.key === "Escape" && moreOpen) {
      event.preventDefault();event.stopPropagation();setMoreOpen(false);moreTrigger.current?.focus();
    }
  }}>
    <button ref={moreTrigger} type="button" className="note-image-more-trigger" aria-label="More image options" title="More image options"
      aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls={moreOpen ? optionsId : undefined}
      onMouseDown={(event) => event.preventDefault()} onClick={() => setMoreOpen((open) => !open)}>•••</button>
    {moreOpen && <div id={optionsId} className={`note-image-options${openAbove ? " is-above" : ""}`} role="dialog" aria-label="Image options">
      <label><span>Text gap</span><input aria-label="Image text gap" type="range" min={8} max={40} value={layout.gap} onChange={(event) => change({ gap: Number(event.target.value) })} /><output>{layout.gap}px</output></label>
      <label><input type="checkbox" checked={layout.showCaption} onChange={(event) => change({ showCaption: event.target.checked })} /> Caption</label>
      <p>Drag anywhere in the note. Text flows along the roomier side of the image.</p>
    </div>}
  </div>;
  return <div className="note-image-toolbar" role="group" aria-label="Image tools">
    <label><span className="sr-only">Image placement</span><select aria-label="Image placement" value={layout.placement} onChange={(event) => {
      const placement = event.target.value as NoteImageLayout["placement"];
      change({ placement, ...(placement === "inline" ? { xPercent: null, offsetY: 0 } : {}),
        ...(placement === "wrap" && layout.xPercent === null && layout.alignment === "center" ? { alignment: "left", widthPercent: Math.min(layout.widthPercent, 55) } : {}) });
    }}><option value="inline">In line</option><option value="break">Above &amp; below</option><option value="wrap">Wrap text</option></select></label>
    <label><span className="sr-only">Image alignment</span><select aria-label="Image alignment" value={layout.xPercent !== null ? "free" : layout.alignment} onChange={(event) => {
      const alignment = event.target.value as NoteImageAlignment;
      change({ alignment, xPercent: null, offsetY: 0, ...(alignment === "center" && layout.placement === "wrap" ? { placement: "break" } : {}) });
    }}><option value="free" disabled>Free</option><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label>
    <label className="note-image-size"><span>Width</span><input aria-label="Image width percent" type="number" min={15} max={100} step={5} value={widthDraft} onChange={(event) => setWidthDraft(event.target.value)} onBlur={saveWidth} onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); saveWidth(); editor.commands.focus(); }
    }} /><span>%</span></label>
    {overflowTarget ? createPortal(moreControl, overflowTarget) : moreControl}
  </div>;
}
