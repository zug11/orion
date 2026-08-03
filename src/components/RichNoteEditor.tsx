import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  findConceptByPhrase,
  type RegisterWikiLinkInput,
} from "../lib/concepts";
import {
  restoreMarkdownFrontmatter,
  splitMarkdownFrontmatter,
} from "../lib/markdown";
import type { Concept, EntityId, Note } from "../types";
import { ConceptLinkPopover } from "./ConceptLinkPopover";
import { EditorToolbar } from "./EditorToolbar";
import { AutoConceptLinks } from "./editor/AutoConceptLinks";

interface RichNoteEditorProps {
  noteId: EntityId;
  markdown: string;
  notes: readonly Note[];
  concepts: readonly Concept[];
  onChange: (markdown: string) => void;
  onRegisterConcept: (input: RegisterWikiLinkInput) => EntityId;
  onDisableConceptAutoLink: (conceptId: EntityId) => void;
  aiArticleDraftingEnabled?: boolean;
  aiProviderName?: string;
}

interface LinkDraft {
  from: number;
  to: number;
  selectedText: string;
  initialPhrase: string;
  initialDestinationIds: EntityId[];
}

export function RichNoteEditor({
  noteId,
  markdown,
  notes,
  concepts,
  onChange,
  onRegisterConcept,
  onDisableConceptAutoLink,
  aiArticleDraftingEnabled = false,
  aiProviderName,
}: RichNoteEditorProps) {
  const initialDocumentRef = useRef(splitMarkdownFrontmatter(markdown));
  const conceptsRef = useRef(concepts);
  const onChangeRef = useRef(onChange);
  const frontmatterRef = useRef(initialDocumentRef.current.prefix);
  const lastEmittedMarkdownRef = useRef(markdown);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [announcement, setAnnouncement] = useState(
    "Editing note. Formatting tools are available.",
  );
  conceptsRef.current = concepts;
  onChangeRef.current = onChange;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          autolink: true,
          openOnClick: false,
          enableClickSelection: true,
          protocols: ["orion-note", "orion-concept"],
          HTMLAttributes: {
            target: null,
            rel: null,
            class: "editor-explicit-link",
          },
        },
      }),
      TableKit.configure({
        table: {
          resizable: false,
          renderWrapper: true,
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: "Start writing…",
        emptyEditorClass: "is-editor-empty",
      }),
      Image.configure({
        allowBase64: false,
        HTMLAttributes: {
          class: "note-embedded-image",
        },
      }),
      Markdown.configure({
        markedOptions: { gfm: true },
      }),
      AutoConceptLinks.configure({
        getConcepts: () => conceptsRef.current,
        excludeNoteId: noteId,
      }),
    ],
    [noteId],
  );

  const editor = useEditor(
    {
      extensions,
      content: initialDocumentRef.current.content,
      contentType: "markdown",
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-label": "Note body",
          "aria-multiline": "true",
          spellcheck: "true",
        },
      },
      onUpdate: ({ editor: current }) => {
        const nextMarkdown = restoreMarkdownFrontmatter(
          frontmatterRef.current,
          current.getMarkdown(),
        );
        lastEmittedMarkdownRef.current = nextMarkdown;
        onChangeRef.current(nextMarkdown);
      },
    },
    [noteId],
  );

  useEffect(() => {
    if (!editor) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      editor.commands.focus("start");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor]);

  useEffect(() => {
    if (!editor || markdown === lastEmittedMarkdownRef.current) {
      return;
    }
    const nextDocument = splitMarkdownFrontmatter(markdown);
    frontmatterRef.current = nextDocument.prefix;
    editor.commands.setContent(nextDocument.content, {
      contentType: "markdown",
      emitUpdate: false,
    });
    lastEmittedMarkdownRef.current = markdown;
  }, [editor, markdown]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    editor.view.dispatch(
      editor.state.tr.setMeta("orionConceptVocabularyChanged", Date.now()),
    );
  }, [concepts, editor]);

  if (!editor) {
    return null;
  }

  function openLinkComposer() {
    const { from, to } = editor.state.selection;
    const selectedText =
      from === to
        ? ""
        : editor.state.doc.textBetween(from, to, " ").trim();
    const existingConcept = selectedText
      ? findConceptByPhrase(concepts, selectedText)
      : undefined;
    setLinkDraft({
      from,
      to,
      selectedText,
      initialPhrase: selectedText,
      initialDestinationIds:
        existingConcept?.noteIds.length && !existingConcept.canonicalNoteId
          ? [...existingConcept.noteIds]
          : [],
    });
    setAnnouncement(
      selectedText
        ? `Creating a reusable link for ${selectedText}.`
        : "Type a phrase to create or reuse its Space article.",
    );
  }

  function applyConceptLink(
    phrase: string,
    destinationIds: EntityId[],
    options: {
      articleMode: "ai" | "blank";
      articleInstructions?: string;
    },
  ) {
    if (!linkDraft) {
      return;
    }
    const conceptId = onRegisterConcept({
      phrase,
      destinationNoteIds: destinationIds,
      articleMode: options.articleMode,
      articleInstructions: options.articleInstructions,
    });
    const href = `orion-concept://${conceptId}`;
    const linkMark = {
      type: "link",
      attrs: {
        href,
        target: null,
        rel: null,
        class: "editor-explicit-link",
      },
    };
    if (
      linkDraft.from !== linkDraft.to &&
      phrase === linkDraft.selectedText
    ) {
      editor
        .chain()
        .focus()
        .setTextSelection({ from: linkDraft.from, to: linkDraft.to })
        .setLink({ href, target: null, rel: null })
        .run();
    } else {
      const before = editor.state.doc.textBetween(
        Math.max(0, linkDraft.from - 1),
        linkDraft.from,
      );
      const after = editor.state.doc.textBetween(
        linkDraft.to,
        Math.min(editor.state.doc.content.size, linkDraft.to + 1),
      );
      const addLeadingSpace = Boolean(
        before && !/[\s([{"'“‘]/.test(before),
      );
      const addTrailingSpace = Boolean(
        after && !/[\s.,!?;:)\]}'"”’]/.test(after),
      );
      const content = [
        ...(addLeadingSpace ? [{ type: "text", text: " " }] : []),
        {
          type: "text",
          text: phrase,
          marks: [linkMark],
        },
        ...(addTrailingSpace ? [{ type: "text", text: " " }] : []),
      ];
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: linkDraft.from, to: linkDraft.to },
          content,
          { updateSelection: true },
        )
        .run();
    }
    setLinkDraft(null);
    setAnnouncement(
      `${phrase} is now a smart link everywhere it appears in Orion.`,
    );
  }

  function unlinkSelection(conceptId?: EntityId) {
    const explicitLink = editor.isActive("link");
    if (explicitLink) {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .unsetLink()
        .run();
    }
    if (conceptId) {
      const concept = concepts.find(
        (candidate) => candidate.id === conceptId,
      );
      onDisableConceptAutoLink(conceptId);
      setAnnouncement(
        `${concept?.label ?? "This phrase"} is no longer an automatic link. Its article was kept.`,
      );
      return;
    }
    setAnnouncement(
      explicitLink
        ? "Link removed. The words were kept."
        : "Select linked words before choosing Unlink.",
    );
  }

  return (
    <div className="rich-note-editor">
      <div className="editor-toolbar-shell">
        <EditorToolbar
          editor={editor}
          concepts={concepts}
          onOpenLink={openLinkComposer}
          onUnlink={unlinkSelection}
        />
      </div>
      <EditorContent
        editor={editor}
        className="note-prose editor-prose"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            openLinkComposer();
          }
        }}
      />
      {linkDraft && (
        <ConceptLinkPopover
          initialPhrase={linkDraft.initialPhrase}
          initialDestinationIds={linkDraft.initialDestinationIds}
          currentNoteId={noteId}
          notes={notes}
          aiArticleDraftingEnabled={aiArticleDraftingEnabled}
          aiProviderName={aiProviderName}
          onCancel={() => {
            setLinkDraft(null);
            setAnnouncement("Link creation cancelled.");
            editor.commands.focus();
          }}
          onSubmit={applyConceptLink}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
