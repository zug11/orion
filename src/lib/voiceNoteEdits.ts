import type { AppSnapshot, ChatRequest, ChatResult } from "../types";
import type { VoiceTurn } from "./voiceConversation";
import { runChatReading } from "./chatReading";
import { validateChatEditTarget } from "./chatEdits";
import { spaceNoteVersion } from "./spaceKnowledge";
import { voiceSelectionReference } from "./voiceSelection";

interface Options {
  snapshot: () => AppSnapshot;
  driver: (request: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>;
  progress: (message: string) => void;
  proposal: (result: ChatResult) => void;
  failed: (message: string) => void;
}

/** One direct editing lane, independent of worker admission and audio playback.
 * It can only prepare the existing Chat review; it has no persistence callback. */
export class VoiceNoteEdits {
  private turns = new WeakMap<object, Map<number, string>>();
  private active?: AbortController;
  constructor(private readonly options: Options) {}

  async run(turn: VoiceTurn, owner: object, conversation: string): Promise<void> {
    const turns = this.turns.get(owner) ?? new Map<number, string>();
    if (turns.get(turn.key) === turn.prompt) return;
    turns.set(turn.key, turn.prompt);
    if (turns.size > 100) turns.delete(turns.keys().next().value!);
    this.turns.set(owner, turns);
    // Only a new editing direction supersedes the pending edit. Ordinary speech
    // and research jobs do not enter this lane or discard its captured target.
    this.cancel();
    const controller = new AbortController(); this.active = controller;
    const snapshot = this.options.snapshot();
    try {
      const noteId = turn.selection?.noteId ?? turn.focusNoteId;
      const note = snapshot.notes.find(item => item.id === noteId);
      if (!note) throw new Error("Open the note you want to edit, then ask for the change.");
      if (turn.selection && (turn.selection.spaceId !== snapshot.workspace.id ||
        turn.selection.noteId !== turn.focusNoteId || turn.selection.version !== spaceNoteVersion(note))) {
        throw new Error("The selected passage changed. Highlight its current text and ask again.");
      }
      this.options.progress("Preparing note changes…");
      const result = await runChatReading(snapshot, turn.prompt, this.options.driver, {
        purpose: "edit", focusNoteId: note.id, editPassage: turn.selection?.text,
        signal: controller.signal, conversationContext: conversation,
        referenceContext: voiceSelectionReference(turn.selection, snapshot, turn.prompt),
        currentSnapshot: this.options.snapshot,
      });
      if (controller.signal.aborted || this.active !== controller) return;
      if (!result.editProposal) throw new Error("Voice did not return reviewable note changes. Please repeat the edit request.");
      validateChatEditTarget(this.options.snapshot(), result.editProposal);
      this.options.proposal(result);
    } catch (error) {
      if (!controller.signal.aborted && this.active === controller) this.options.failed(error instanceof Error ? error.message : "The note changes could not be prepared. Try again.");
    } finally {
      if (this.active === controller) { this.active = undefined; this.options.progress(""); }
    }
  }

  cancel() { this.active?.abort(); this.active = undefined; this.options.progress(""); }
  dispose() { this.cancel(); this.turns = new WeakMap(); }
}
