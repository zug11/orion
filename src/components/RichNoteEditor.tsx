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
import {
  canonicalizeSourceCitations,
  type SourceCitationReference,
} from "../lib/sourceCitations";
import type { Concept, EntityId, Note, Source } from "../types";
import { ConceptLinkPopover } from "./ConceptLinkPopover";
import { EditorToolbar } from "./EditorToolbar";
import { SourceCitationPopover } from "./SourceCitationPopover";
import { SourceReferences } from "./SourceReferences";
import { AutoConceptLinks } from "./editor/AutoConceptLinks";
import { FindInNote, findInNotePluginKey } from "./editor/FindInNote";

interface RichNoteEditorProps {
  noteId: EntityId;
  markdown: string;
  notes: readonly Note[];
  concepts: readonly Concept[];
  sources: readonly Source[];
  attachedSourceIds: readonly EntityId[];
  onChange: (markdown: string) => void;
  onAttachSource: (sourceId: EntityId) => void;
  onOpenSource?: (sourceId: EntityId) => void;
  onRegisterConcept: (input: RegisterWikiLinkInput) => EntityId;
  onDisableConceptAutoLink: (conceptId: EntityId) => void;
  aiArticleWritingEnabled?: boolean;
  aiProviderName?: string;
  findQuery?: string;
  onFindDecorationsChanged?: () => void;
}

interface LinkDraft {
  from: number;
  to: number;
  selectedText: string;
  initialPhrase: string;
  initialDestinationIds: EntityId[];
}

interface CitationDraft {
  position: number;
}

function sameCitationReferences(
  left: readonly SourceCitationReference[],
  right: readonly SourceCitationReference[],
) {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index];
      return (
        reference.available === candidate.available &&
        reference.number === candidate.number &&
        reference.sourceId === candidate.sourceId &&
        reference.title === candidate.title
      );
    })
  );
}

export function RichNoteEditor({
  noteId,
  markdown,
  notes,
  concepts,
  sources,
  attachedSourceIds,
  onChange,
  onAttachSource,
  onOpenSource,
  onRegisterConcept,
  onDisableConceptAutoLink,
  aiArticleWritingEnabled = false,
  aiProviderName,
  findQuery = "",
  onFindDecorationsChanged,
}: RichNoteEditorProps) {
  const [initialDocument] = useState(() => {
    const document = splitMarkdownFrontmatter(markdown);
    const citations = canonicalizeSourceCitations(document.content, sources);
    return {
      content: citations.body,
      prefix: document.prefix,
      references: citations.references,
    };
  });
  const conceptsRef = useRef(concepts);
  const sourcesRef = useRef(sources);
  const onChangeRef = useRef(onChange);
  const frontmatterRef = useRef(initialDocument.prefix);
  const lastEmittedMarkdownRef = useRef(markdown);
  const findQueryRef = useRef(findQuery);
  const onFindDecorationsChangedRef = useRef(onFindDecorationsChanged);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [citationDraft, setCitationDraft] = useState<CitationDraft | null>(null);
  const [citationReferences, setCitationReferences] = useState<
    SourceCitationReference[]
  >(initialDocument.references);
  const [announcement, setAnnouncement] = useState(
    "Editing note. Formatting tools are available.",
  );
  conceptsRef.current = concepts;
  sourcesRef.current = sources;
  onChangeRef.current = onChange;
  findQueryRef.current = findQuery;
  onFindDecorationsChangedRef.current = onFindDecorationsChanged;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          autolink: true,
          openOnClick: false,
          enableClickSelection: true,
          protocols: ["orion-note", "orion-concept", "orion-source"],
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
      FindInNote.configure({
        getQuery: () => findQueryRef.current,
      }),
    ],
    [noteId],
  );

  const editor = useEditor(
    {
      extensions,
      content: initialDocument.content,
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
        const citations = canonicalizeSourceCitations(
          current.getMarkdown(),
          sourcesRef.current,
        );
        const nextMarkdown = restoreMarkdownFrontmatter(
          frontmatterRef.current,
          citations.markdown,
        );
        setCitationReferences((current) =>
          sameCitationReferences(current, citations.references)
            ? current
            : citations.references,
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
    const citations = canonicalizeSourceCitations(
      nextDocument.content,
      sourcesRef.current,
    );
    frontmatterRef.current = nextDocument.prefix;
    editor.commands.setContent(citations.body, {
      contentType: "markdown",
      emitUpdate: false,
    });
    setCitationReferences((current) =>
      sameCitationReferences(current, citations.references)
        ? current
        : citations.references,
    );
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

  useEffect(() => {
    if (!editor) return undefined;
    editor.view.dispatch(
      editor.state.tr.setMeta(findInNotePluginKey, Date.now()),
    );
    const frame = window.requestAnimationFrame(() => {
      onFindDecorationsChangedRef.current?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor, findQuery]);

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
    setCitationDraft(null);
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

  function openCitationPicker() {
    if (sources.length === 0) {
      setAnnouncement("This Space has no sources to cite yet.");
      return;
    }
    setLinkDraft(null);
    setCitationDraft({ position: editor.state.selection.to });
    setAnnouncement("Choose a source to cite.");
  }

  function insertSourceCitation(source: Source) {
    if (!citationDraft) return;
    const position = Math.min(
      citationDraft.position,
      editor.state.doc.content.size,
    );
    const before = editor.state.doc.textBetween(
      Math.max(0, position - 1),
      position,
    );
    const after = editor.state.doc.textBetween(
      position,
      Math.min(editor.state.doc.content.size, position + 1),
    );
    const addLeadingSpace = Boolean(before && !/[\s([{"'“‘]/.test(before));
    const addTrailingSpace = Boolean(
      after && !/[\s.,!?;:)\]}'"”’]/.test(after),
    );
    const href = `orion-source://${source.id}`;
    const existingReferences = canonicalizeSourceCitations(
      editor.getMarkdown(),
      sources,
    ).references;
    const citationNumber =
      existingReferences.find((reference) => reference.sourceId === source.id)
        ?.number ?? existingReferences.length + 1;
    const citationMark = {
      type: "link",
      attrs: {
        href,
        target: null,
        rel: null,
        class: "editor-explicit-link",
        title: null,
      },
    };
    const inserted = editor
      .chain()
      .focus()
      .insertContentAt(
        position,
        [
          ...(addLeadingSpace ? [{ type: "text", text: " " }] : []),
          {
            type: "text",
            text: String(citationNumber),
            marks: [citationMark],
          },
          ...(addTrailingSpace ? [{ type: "text", text: " " }] : []),
        ],
        { updateSelection: true },
      )
      .run();
    if (inserted) {
      onAttachSource(source.id);
      setAnnouncement(`Citation to ${source.title} inserted.`);
    } else {
      setAnnouncement("The citation could not be inserted here.");
    }
    setCitationDraft(null);
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
      const href = String(editor.getAttributes("link").href ?? "");
      if (href.startsWith("orion-source://")) {
        editor
          .chain()
          .focus()
          .extendMarkRange("link")
          .deleteSelection()
          .run();
        setAnnouncement("Citation removed. References were renumbered.");
        return;
      }
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
          citationAvailable={sources.length > 0}
          onOpenCitation={openCitationPicker}
          onAnnounce={setAnnouncement}
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
      <SourceReferences
        references={citationReferences}
        onOpenSource={onOpenSource}
      />
      {linkDraft && (
        <ConceptLinkPopover
          initialPhrase={linkDraft.initialPhrase}
          initialDestinationIds={linkDraft.initialDestinationIds}
          currentNoteId={noteId}
          notes={notes}
          aiArticleWritingEnabled={aiArticleWritingEnabled}
          aiProviderName={aiProviderName}
          onCancel={() => {
            setLinkDraft(null);
            setAnnouncement("Link creation cancelled.");
            editor.commands.focus();
          }}
          onSubmit={applyConceptLink}
        />
      )}
      {citationDraft ? (
        <SourceCitationPopover
          sources={sources}
          attachedSourceIds={attachedSourceIds}
          onCancel={() => {
            setCitationDraft(null);
            setAnnouncement("Citation cancelled.");
            editor.commands.focus();
          }}
          onSelect={insertSourceCitation}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
