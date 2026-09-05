import type { AppSnapshot, ChatRequest, ChatResult, ParsedImport } from "../../types";
import type { GenerateKind } from "../generate";
import type { KnowledgeAssignmentDriver } from "../knowledgeOrchestration/service";
import type { organizeWithAI } from "../storage";
import type { buildImportPayload } from "../../components/ImportStudio";

export interface ContextInput { query: string; note_ids?: string[]; source_ids?: string[]; depth?: "standard" | "deep" }
export interface ResearchInput extends Omit<ContextInput, "query"> {
  question: string; material?: string; mode?: "answer" | "compare" | "gaps" | "review" | "brief"; previous_job_id?: string;
}
export type ImportInput = { kind: "text"; title: string; text: string } | { kind: "file"; path: string } | { kind: "url"; url: string };
export type AssistantRequest = { space_id: string; request_id: string } & (
  | { operation: "context"; input: ContextInput }
  | { operation: "research"; input: ResearchInput }
  | { operation: "import"; input: { inputs: ImportInput[]; guidance?: string; mode?: "ai" | "local" } }
  | { operation: "reprocess"; input: { source_ids: string[]; guidance?: string } }
  | { operation: "generate"; input: { kind: GenerateKind; instruction: string; title?: string } }
  | { operation: "develop_concept"; input: { title: string; origin_note_id: string; instruction?: string } }
  | { operation: "enrich_knowledge"; input: { note_id: string } }
  | { operation: "refresh_overview"; input: Record<string, never> }
);
export interface AssistantClaim { id: string; request: AssistantRequest }
export interface AssistantJob {
  id: string; spaceId: string; operation: AssistantRequest["operation"];
  state: "queued" | "running" | "committing" | "succeeded" | "failed" | "cancelled";
  stage: string; createdAt: number; updatedAt: number;
  result?: Record<string, unknown>; error?: string;
}
export interface WorkflowResult { result: Record<string, unknown>; snapshot?: AppSnapshot }
export interface WorkflowDependencies {
  signal: AbortSignal;
  assertCurrent: () => Promise<void>;
  progress: (stage: string) => Promise<void>;
  chat: (request: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>;
  organize: typeof organizeWithAI;
  driver: KnowledgeAssignmentDriver;
  buildImportPayload: typeof buildImportPayload;
  readInput: (index: number) => Promise<ParsedImport>;
  previousResult: (jobId: string) => Promise<Record<string, unknown>>;
  illustrate: (body: string, title: string) => Promise<{ body: string; warnings: string[] }>;
}
