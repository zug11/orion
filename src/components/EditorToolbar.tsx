import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  BookOpen,
  Bold as BoldIcon,
  Braces,
  FileCode2,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListTodo,
  ListOrdered,
  Quote,
  Redo2,
  Sheet,
  Undo2,
  Unlink,
} from "../lib/icons";
import {
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { findConceptByPhrase } from "../lib/concepts";
import type { Concept, EntityId } from "../types";
import { AIWritingMark } from "./icons/AIWritingMark";
import { NOTE_IMAGE_ACCEPT } from "../lib/noteImages";

interface EditorToolbarProps {
  editor: Editor;
  concepts: readonly Concept[];
  onOpenLink: () => void;
  onUnlink: (conceptId?: EntityId) => void;
  citationAvailable: boolean;
  onOpenCitation: () => void;
  onInsertImages?: (files: readonly File[]) => void;
  imageBusy?: boolean;
  aiWritingAvailable?: boolean;
  aiWritingActive?: boolean;
  aiWritingBusy?: boolean;
  aiProviderName?: string;
  onToggleAIWriting?: () => void;
  onAnnounce?: (message: string) => void;
}

export function EditorToolbar({
  editor,
  concepts,
  onOpenLink,
  onUnlink,
  citationAvailable,
  onOpenCitation,
  onInsertImages,
  imageBusy = false,
  aiWritingAvailable = false,
  aiWritingActive = false,
  aiWritingBusy = false,
  aiProviderName = "AI",
  onToggleAIWriting,
  onAnnounce,
}: EditorToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (current.isDestroyed) {
        return {
          bold: false,
          italic: false,
          strike: false,
          code: false,
          codeBlock: false,
          bulletList: false,
          orderedList: false,
          taskList: false,
          blockquote: false,
          table: false,
          tableHeader: false,
          link: false,
          sourceCitation: false,
          heading: "0",
          canUndo: false,
          canRedo: false,
          canInsertDivider: false,
          canInsertTable: false,
          canAddRowBefore: false,
          canAddRowAfter: false,
          canDeleteRow: false,
          canAddColumnBefore: false,
          canAddColumnAfter: false,
          canDeleteColumn: false,
          canToggleHeaderRow: false,
          canDeleteTable: false,
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
      const selectedConceptId = !linkHref && selectedText
        ? findConceptByPhrase(concepts, selectedText)?.id
        : undefined;
      const unlinkConceptId = explicitConceptId ?? selectedConceptId;
      const link = current.isActive("link");
      const table = current.isActive("table");
      return {
        bold: current.isActive("bold"),
        italic: current.isActive("italic"),
        strike: current.isActive("strike"),
        code: current.isActive("code"),
        codeBlock: current.isActive("codeBlock"),
        bulletList: current.isActive("bulletList"),
        orderedList: current.isActive("orderedList"),
        taskList: current.isActive("taskList"),
        blockquote: current.isActive("blockquote"),
        table,
        tableHeader: current.isActive("tableHeader"),
        link,
        sourceCitation: linkHref.startsWith("orion-source://"),
        heading:
          current.isActive("heading", { level: 2 })
            ? "2"
            : current.isActive("heading", { level: 3 })
              ? "3"
              : "0",
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
        canInsertDivider: current.can().setHorizontalRule(),
        canInsertTable:
          !table &&
          current.can().insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
        canAddRowBefore: table && current.can().addRowBefore(),
        canAddRowAfter: table && current.can().addRowAfter(),
        canDeleteRow: table && current.can().deleteRow(),
        canAddColumnBefore: table && current.can().addColumnBefore(),
        canAddColumnAfter: table && current.can().addColumnAfter(),
        canDeleteColumn: table && current.can().deleteColumn(),
        canToggleHeaderRow: table && current.can().toggleHeaderRow(),
        canDeleteTable: table && current.can().deleteTable(),
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

  function runTableAction(event: ChangeEvent<HTMLSelectElement>) {
    const action = event.target.value;
    if (!action) return;
    const chain = editor.chain().focus();
    switch (action) {
      case "add-row-before":
        chain.addRowBefore().run();
        onAnnounce?.("Row added above.");
        break;
      case "add-row-after":
        chain.addRowAfter().run();
        onAnnounce?.("Row added below.");
        break;
      case "delete-row":
        chain.deleteRow().run();
        onAnnounce?.("Row deleted.");
        break;
      case "add-column-before":
        chain.addColumnBefore().run();
        onAnnounce?.("Column added to the left.");
        break;
      case "add-column-after":
        chain.addColumnAfter().run();
        onAnnounce?.("Column added to the right.");
        break;
      case "delete-column":
        chain.deleteColumn().run();
        onAnnounce?.("Column deleted.");
        break;
      case "toggle-header-row":
        chain.toggleHeaderRow().run();
        onAnnounce?.(
          state.tableHeader ? "Header row removed." : "Header row added.",
        );
        break;
      case "delete-table":
        chain.deleteTable().run();
        onAnnounce?.("Table deleted. Undo is available.");
        break;
    }
  }

  return (
    <div
      ref={toolbarRef}
      className="editor-toolbar"
      role="toolbar"
      aria-label="Text formatting"
      onKeyDown={moveToolbarFocus}
    >
      <div
        className="editor-toolbar-main"
        inert={aiWritingBusy ? true : undefined}
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
          className={state.strike ? "active" : ""}
          aria-label="Strikethrough"
          aria-pressed={state.strike}
          title="Strikethrough (⇧⌘S)"
          onMouseDown={preserveSelection}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <span className="editor-toolbar-glyph" aria-hidden="true">
            <s>S</s>
          </span>
        </button>
        <button
          type="button"
          className={state.code ? "active" : ""}
          aria-label="Inline code"
          aria-pressed={state.code}
          title="Inline code (⌘E)"
          onMouseDown={preserveSelection}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Braces size={15} />
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
        <button
          type="button"
          className={state.codeBlock ? "active" : ""}
          aria-label="Code block"
          aria-pressed={state.codeBlock}
          title="Fenced code block"
          onMouseDown={preserveSelection}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          <FileCode2 size={15} />
        </button>
        <button
          type="button"
          aria-label="Insert divider"
          title="Horizontal divider"
          disabled={!state.canInsertDivider}
          onMouseDown={preserveSelection}
          onClick={() => {
            editor.chain().focus().setHorizontalRule().run();
            onAnnounce?.("Divider inserted.");
          }}
        >
          <span className="editor-toolbar-glyph" aria-hidden="true">―</span>
        </button>
        <button
          type="button"
          aria-label="Insert table"
          title={state.table ? "Choose a table action" : "Insert 3 by 3 table"}
          disabled={!state.canInsertTable}
          onMouseDown={preserveSelection}
          onClick={() => {
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run();
            onAnnounce?.("Table inserted. Use Tab to move between cells.");
          }}
        >
          <Sheet size={15} />
        </button>
        <button
          type="button"
          aria-label="Insert image"
          title="Insert image"
          disabled={imageBusy || !onInsertImages}
          onMouseDown={preserveSelection}
          onClick={() => imageInputRef.current?.click()}
        >
          <ImageIcon size={15} />
        </button>
        <input
          ref={imageInputRef}
          className="sr-only"
          type="file"
          accept={NOTE_IMAGE_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length > 0) onInsertImages?.(files);
          }}
        />

        {state.table ? (
          <label className="editor-style-select editor-table-action-select">
            <span className="sr-only">Table actions</span>
            <select
              value=""
              aria-label="Table actions"
              title="Table actions"
              onChange={runTableAction}
            >
              <option value="">Table</option>
              <option value="add-row-before" disabled={!state.canAddRowBefore}>
                Add row above
              </option>
              <option value="add-row-after" disabled={!state.canAddRowAfter}>
                Add row below
              </option>
              <option value="delete-row" disabled={!state.canDeleteRow}>
                Delete row
              </option>
              <option
                value="add-column-before"
                disabled={!state.canAddColumnBefore}
              >
                Add column left
              </option>
              <option
                value="add-column-after"
                disabled={!state.canAddColumnAfter}
              >
                Add column right
              </option>
              <option value="delete-column" disabled={!state.canDeleteColumn}>
                Delete column
              </option>
              <option
                value="toggle-header-row"
                disabled={!state.canToggleHeaderRow}
              >
                {state.tableHeader ? "Remove header row" : "Make header row"}
              </option>
              <option value="delete-table" disabled={!state.canDeleteTable}>
                Delete table
              </option>
            </select>
          </label>
        ) : null}

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
        <button
          type="button"
          className={
            state.sourceCitation
              ? "link-tool citation-tool active"
              : "link-tool citation-tool"
          }
          aria-label="Cite a source"
          aria-pressed={state.sourceCitation}
          aria-haspopup="dialog"
          title={
            citationAvailable
              ? "Cite a source from this Space"
              : "This Space has no sources to cite"
          }
          disabled={!citationAvailable}
          onMouseDown={preserveSelection}
          onClick={onOpenCitation}
        >
          <BookOpen size={15} />
          <span>Cite</span>
        </button>
      </div>

      <div className="editor-toolbar-ai" role="group" aria-label="AI writing">
        <button
          type="button"
          className={`${aiWritingActive ? "active " : ""}ai-writing-toggle${
            aiWritingAvailable ? "" : " is-unavailable"
          }`}
          aria-label={aiWritingActive ? "Turn off AI writing" : "Turn on AI writing"}
          aria-pressed={aiWritingActive}
          aria-disabled={!aiWritingAvailable}
          title={
            aiWritingAvailable
              ? aiWritingActive
                ? "Turn off AI writing"
                : "AI writing"
              : `Add an ${aiProviderName} key in Settings to use AI writing`
          }
          data-tooltip={
            aiWritingAvailable
              ? aiWritingActive
                ? "Turn off AI writing"
                : "AI writing"
              : `Add an ${aiProviderName} key in Settings`
          }
          onMouseDown={preserveSelection}
          onClick={onToggleAIWriting}
        >
          <AIWritingMark size={15} />
        </button>
      </div>

      <div
        className="editor-toolbar-history"
        role="group"
        aria-label="Editing history"
        inert={aiWritingBusy ? true : undefined}
      >
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
    </div>
  );
}
