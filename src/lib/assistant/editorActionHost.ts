/** Transient rich-editor capability. Captures and grants never enter the vault. */
export type EditorActionSpec =
  | { kind: "write"; amount: "sentence" | "paragraph" | "section"; instruction?: string }
  | { kind: "rewrite"; preset: "rewrite" | "clarify" | "tighten" | "simplify" | "expand" | "enrich"; instruction?: string }
  | { kind: "image"; quality: "fast" | "detailed"; context: "selection" | "space"; instruction?: string };
export interface EditorActionGrant { actionId: string; sessionId: string }
export interface EditorActionCapture {
  captureId: string;
  noteId: string;
  /** Exact authored serialization for version binding, never filtered replacement text. */
  markdown: string;
  selection: { from: number; to: number; empty: boolean };
  effectiveTarget: { from: number; to: number; mode: "inline" | "code" | "blocks" | "append" };
  documentVersion: string;
  selectionVersion: string;
  action: EditorActionSpec;
}
export type EditorActionPhase = "generating" | "preview" | "error" | "accepting" | "accepted" | "discarded" | "cancelled" | "stale";
export interface EditorActionState { captureId: string; phase: EditorActionPhase; error?: string }
export interface EditorActionStartOptions {
  grant: EditorActionGrant;
  /** Native ownership and current permission must be claimed before any editor mutation. */
  beforeReview: () => Promise<void>;
  beforeAccept: () => Promise<void>;
  /** Runs exactly once after the ordinary editor transaction emitted its full serialization. */
  afterAccept: (exactSerializedBody: string) => Promise<void>;
  onState: (state: EditorActionState) => void;
}
export interface EditorActionHost {
  getState: () => { ready: boolean; documentVersion: string; selectionVersion: string };
  capture: (action: EditorActionSpec) => EditorActionCapture;
  isCaptureCurrent: (captureId: string) => boolean;
  start: (captureId: string, options: EditorActionStartOptions) => void;
  /** Cancellation succeeds until an accepted editor mutation has happened. */
  cancel: (captureId: string) => boolean;
  release: (captureId: string) => void;
}
