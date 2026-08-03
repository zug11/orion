import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Bold as BoldIcon,
  Italic,
  Link2,
  List,
  ListTodo,
  ListOrdered,
  Quote,
  Redo2,
  Undo2,
  Unlink,
} from "../lib/icons";
import { useRef, type KeyboardEvent, type MouseEvent } from "react";
import { findConceptByPhrase } from "../lib/concepts";
import type { Concept, EntityId } from "../types";

interface EditorToolbarProps {
  editor: Editor;
  concepts: readonly Concept[];
  onOpenLink: () => void;
  onUnlink: (conceptId?: EntityId) => void;
}

export function EditorToolbar({
  editor,
  concepts,
  onOpenLink,
  onUnlink,
}: EditorToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (current.isDestroyed) {
        return {
          bold: false,
          italic: false,
          bulletList: false,
          orderedList: false,
          taskList: false,
          blockquote: false,
          link: false,
          heading: "0",
          canUndo: false,
          canRedo: false,
          unlinkConceptId: undefined,
          canUnlink: false,
        };
      }
      const { from, to } = current.state.selection;
      const selectedText =
        from === to
          ? ""
          : current.state.doc.textBetween(from, to, " ").trim();
      const linkHref = String(
        current.getAttributes("link").href ?? "",
      );
      const explicitConceptId = linkHref.startsWith("orion-concept://")
        ? linkHref.slice("orion-concept://".length)
        : undefined;
      const selectedConceptId = selectedText
        ? findConceptByPhrase(concepts, selectedText)?.id
        : undefined;
      const unlinkConceptId = explicitConceptId ?? selectedConceptId;
      const link = current.isActive("link");
      return {
        bold: current.isActive("bold"),
        italic: current.isActive("italic"),
        bulletList: current.isActive("bulletList"),
        orderedList: current.isActive("orderedList"),
        taskList: current.isActive("taskList"),
        blockquote: current.isActive("blockquote"),
        link,
        heading:
          current.isActive("heading", { level: 2 })
            ? "2"
            : current.isActive("heading", { level: 3 })
              ? "3"
              : "0",
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
        unlinkConceptId,
        canUnlink: link || Boolean(unlinkConceptId),
      };
    },
  });

  function preserveSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
  }

  function moveToolbarFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      return;
    }
    const controls = [
      ...(toolbarRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled])',
      ) ?? []),
    ];
    if (controls.length === 0) {
      return;
    }
    const currentIndex = Math.max(
      0,
      controls.indexOf(document.activeElement as HTMLElement),
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + controls.length) % controls.length
            : (currentIndex + 1) % controls.length;
    event.preventDefault();
    controls[nextIndex].focus();
  }

  return (
    <div
      ref={toolbarRef}
      className="editor-toolbar"
      role="toolbar"
      aria-label="Text formatting"
      onKeyDown={moveToolbarFocus}
    >
      <label className="editor-style-select" title="Text style">
        <span className="sr-only">Text style</span>
        <select
          value={state.heading}
          aria-label="Text style"
          onChange={(event) => {
            const level = Number(event.target.value);
            if (level === 2 || level === 3) {
              editor.chain().focus().setHeading({ level }).run();
            } else {
              editor.chain().focus().setParagraph().run();
            }
          }}
        >
          <option value="0">Text</option>
          <option value="2">Heading</option>
          <option value="3">Subheading</option>
        </select>
      </label>

      <span className="editor-toolbar-separator" aria-hidden="true" />

      <button
        type="button"
        className={state.bold ? "active" : ""}
        aria-label="Bold"
        aria-pressed={state.bold}
        title="Bold (⌘B)"
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <BoldIcon size={15} />
      </button>
      <button
        type="button"
        className={state.italic ? "active" : ""}
        aria-label="Italic"
        aria-pressed={state.italic}
        title="Italic (⌘I)"
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={15} />
      </button>
      <button
        type="button"
        className={state.bulletList ? "active" : ""}
        aria-label="Bulleted list"
        aria-pressed={state.bulletList}
        title="Bulleted list"
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={16} />
      </button>
      <button
        type="button"
        className={state.orderedList ? "active" : ""}
        aria-label="Numbered list"
        aria-pressed={state.orderedList}
        title="Numbered list"
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={16} />
      </button>
      <button
        type="button"
        className={state.taskList ? "active" : ""}
        aria-label="To-do list"
        aria-pressed={state.taskList}
        title="To-do list"
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <ListTodo size={16} />
      </button>
      <button
        type="button"
        className={state.blockquote ? "active" : ""}
        aria-label="Quote"
        aria-pressed={state.blockquote}
        title="Quote"
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={15} />
      </button>

      <span className="editor-toolbar-separator" aria-hidden="true" />

      <button
        type="button"
        className={state.link ? "active link-tool" : "link-tool"}
        aria-label="Create reusable link"
        aria-pressed={state.link}
        aria-haspopup="dialog"
        title="Teach Orion a link (⌘K)"
        onMouseDown={preserveSelection}
        onClick={onOpenLink}
      >
        <Link2 size={15} />
        <span>Link</span>
      </button>
      <button
        type="button"
        className="unlink-tool"
        aria-label="Unlink selected text"
        title="Unlink selected text"
        disabled={!state.canUnlink}
        onMouseDown={preserveSelection}
        onClick={() => onUnlink(state.unlinkConceptId)}
      >
        <Unlink size={15} />
        <span>Unlink</span>
      </button>

      <span className="editor-toolbar-spacer" />

      <button
        type="button"
        aria-label="Undo"
        title="Undo (⌘Z)"
        disabled={!state.canUndo}
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 size={14} />
      </button>
      <button
        type="button"
        aria-label="Redo"
        title="Redo (⇧⌘Z)"
        disabled={!state.canRedo}
        onMouseDown={preserveSelection}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 size={14} />
      </button>
    </div>
  );
}
