import type { AppSnapshot } from "../types";
import { completedTaskRanges, requestedTaskView, workingTaskSnapshot, workingTaskText } from "./taskWorkingView";

/** A transient, host-produced projection of the rich document. Never edit with it. */
export interface EditorAIWorkingContext {
  documentMarkdown: string;
  selectedMarkdown: string;
  selectedText: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  selectionTouchesCompleted: boolean;
  caretInsideCompleted: boolean;
}

export interface EditorAIContextInput {
  originNoteId: string;
  instruction?: string;
  documentMarkdown?: string;
  selectedMarkdown?: string;
  selectedText?: string;
  beforeMarkdown?: string;
  afterMarkdown?: string;
  workingContext?: EditorAIWorkingContext;
}

export interface EditorAILinkContext {
  documentMarkdown: string;
  workingContext: EditorAIWorkingContext;
}

/**
 * Provider data is a separate projection. The editor keeps its original rich
 * slice, including every completed task, for preview/Accept/Discard/Undo.
 * Only the current custom instruction can request history; note text cannot.
 */
export function projectEditorAIContext<T extends EditorAIContextInput>(
  snapshot: AppSnapshot,
  input: T,
  purpose: "write" | "rewrite" | "image" | "link",
): { snapshot: AppSnapshot; input: T; taskView: "working" | "history" } {
  const origin = snapshot.notes.find(note => note.id === input.originNoteId);
  if (!origin) throw new Error("The note being edited is no longer in this Space.");
  const taskView = requestedTaskView(input.instruction ?? "");
  if (taskView === "history") return { snapshot, input, taskView };

  const documentMarkdown = input.documentMarkdown ?? origin.body;
  const projection = input.workingContext;
  const hasHiddenDocument = completedTaskRanges(documentMarkdown).length > 0;
  if (projection?.selectionTouchesCompleted || projection?.caretInsideCompleted ||
    completedTaskRanges(input.selectedMarkdown ?? input.selectedText ?? "").length > 0) {
    throw new Error(purpose === "link"
      ? "This selection includes completed work. Enter the page title yourself, or select unfinished text."
      : purpose === "write"
      ? "This cursor or selection is inside completed work. Choose unfinished text, or explicitly ask to include completed tasks in Custom instructions."
      : "This selection includes completed work. Select unfinished text, or explicitly ask to include completed tasks in the instruction field.");
  }
  // Plain fragments can have lost their enclosing checkbox. Without the real
  // rich capture, do not guess offsets or authorize a filtered replacement.
  if (hasHiddenDocument && !projection &&
    Boolean(input.selectedMarkdown?.trim() || input.selectedText?.trim() || input.beforeMarkdown !== undefined || input.afterMarkdown !== undefined)) {
    throw new Error(purpose === "link"
      ? "The completed-task boundary of this selection is unavailable. Select the passage again, or enter the page title yourself."
      : "The completed-task boundary of this selection is unavailable. Select the passage again, or explicitly ask to include completed tasks.");
  }
  // Include the live draft before clearing derivatives: an unsaved newly
  // completed item may still appear in the saved note's summary/overview.
  const liveSnapshot = documentMarkdown === origin.body ? snapshot : {
    ...snapshot,
    notes: snapshot.notes.map(note => note.id === origin.id ? { ...note, body: documentMarkdown } : note),
  };
  let working = workingTaskSnapshot(liveSnapshot);
  const safeDocument = projection?.documentMarkdown ?? workingTaskText(documentMarkdown);
  // A rich checked task may enclose nested blocks that plain Markdown cannot
  // disambiguate. Use the editor's safe whole-document projection for its body.
  if (working.notes.find(note => note.id === origin.id)!.body !== safeDocument) {
    working = { ...working, notes: working.notes.map(note => ({ ...note,
      ...(note.id === origin.id ? { body: safeDocument } : {}), summary: "",
    })), concepts: working.concepts.map(concept => ({ ...concept, description: "" })),
    relationships: working.relationships.map(relation => ({ ...relation, context: undefined })),
    spaceOverview: undefined, spaceKnowledge: undefined };
  }
  return { snapshot: working, taskView, input: { ...input,
    documentMarkdown: safeDocument,
    selectedMarkdown: projection?.selectedMarkdown ?? workingTaskText(input.selectedMarkdown ?? ""),
    selectedText: projection?.selectedText ?? workingTaskText(input.selectedText ?? ""),
    beforeMarkdown: projection?.beforeMarkdown ?? (input.beforeMarkdown === undefined ? undefined : workingTaskText(input.beforeMarkdown)),
    afterMarkdown: projection?.afterMarkdown ?? (input.afterMarkdown === undefined ? undefined : workingTaskText(input.afterMarkdown)),
  } };
}
