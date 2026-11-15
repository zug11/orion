/**
 * A short in-memory record of things that went wrong in this window.
 *
 * Orion deliberately keeps no logs: nothing here is written to disk, sent
 * anywhere, or kept past the window's lifetime. It exists so that a problem
 * can be reported with something more useful than "it broke". The user copies
 * the details explicitly; messages are bounded and carry no vault content of
 * their own beyond what an error message happens to contain.
 */
export type ProblemKind = "render" | "error" | "rejection";

export interface Problem {
  at: string;
  kind: ProblemKind;
  message: string;
  detail?: string;
}

const MAX_PROBLEMS = 30;
const MAX_MESSAGE_CHARS = 400;
const MAX_DETAIL_CHARS = 1_500;
const problems: Problem[] = [];

function messageOf(error: unknown): string {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string" ? error : "Unknown problem";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS) || "Unknown problem";
}

export function recordProblem(kind: ProblemKind, error: unknown, detail?: string): void {
  problems.push({
    at: new Date().toISOString(),
    kind,
    message: messageOf(error),
    ...(detail ? { detail: detail.trim().slice(0, MAX_DETAIL_CHARS) } : {}),
  });
  if (problems.length > MAX_PROBLEMS) problems.splice(0, problems.length - MAX_PROBLEMS);
}

export function recentProblems(): readonly Problem[] {
  return problems;
}

export function clearProblems(): void {
  problems.length = 0;
}

/** Plain text for a bug report. */
export function describeProblems(): string {
  const environment = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return [
    "Orion problem report",
    environment,
    ...problems.map((problem) =>
      `[${problem.at}] ${problem.kind}: ${problem.message}${problem.detail ? `\n${problem.detail}` : ""}`),
  ].filter(Boolean).join("\n\n");
}

/**
 * Uncaught errors and unhandled promise rejections otherwise vanish. Record
 * them; a rejected promise is often benign, so nothing is shown to the user.
 */
export function installGlobalProblemHandlers(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => recordProblem("error", event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => recordProblem("rejection", event.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
