import type { Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Step, StepResult } from "@tiptap/pm/transform";
import type { WritingOrigin } from "../../types";

export interface WritingOriginChange { origin: WritingOrigin; present: boolean }

// Transaction metadata would disappear on Undo. A position-free step travels
// with the same history event as the text without adding anything to Markdown.
// Editor history is window-local. Keep the tag stable across dev reloads without
// registering a global ProseMirror deserializer for a step that never goes on disk.
const writingOriginStep = Symbol.for("orion.editor.writingOrigin");
class WritingOriginStep extends Step {
  readonly [writingOriginStep] = true;
  constructor(readonly change: WritingOriginChange) { super(); }
  apply(doc: Node) { return StepResult.ok(doc); }
  invert() { return new WritingOriginStep({ ...this.change, present: !this.change.present }); }
  map() { return this; }
  toJSON() { return { stepType: "orionWritingOrigin", ...this.change }; }
}

export function recordWritingOrigin(tr: Transaction, origin?: WritingOrigin, present = true): Transaction {
  if (origin && tr.docChanged && !tr.doc.eq(tr.before)) tr.step(new WritingOriginStep({ origin, present }));
  return tr;
}

export function transactionWritingOrigin(tr: Transaction): WritingOriginChange | undefined {
  for (const step of tr.steps) if (writingOriginStep in step) return (step as WritingOriginStep).change;
}
