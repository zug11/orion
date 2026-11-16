import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProblems, describeProblems, installGlobalProblemHandlers, recentProblems, recordProblem } from "../lib/diagnostics";
import { ErrorBoundary } from "./ErrorBoundary";

function Fragile({ broken, name = "Kanban card" }: { broken: boolean; name?: string }) {
  if (broken) throw new Error(`${name} could not render`);
  return <p>{name} is fine</p>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    clearProblems();
    // React logs caught render errors; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("contains a failing view and leaves its neighbours working", () => {
    render(
      <div>
        <p>Sidebar still here</p>
        <ErrorBoundary label="this note"><Fragile broken /></ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("Sidebar still here")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Orion couldn’t show this note");
    expect(screen.getByRole("alert")).toHaveTextContent("still being saved");
    expect(recentProblems()).toHaveLength(1);
    expect(recentProblems()[0]).toMatchObject({ kind: "render", message: "Error: Kanban card could not render" });
    expect(recentProblems()[0].detail).toContain("Fragile");
  });

  it("retries on request and when the reset key changes", () => {
    const view = render(<ErrorBoundary label="this view" resetKey="note-a"><Fragile broken /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Still broken: trying again shows the failure again rather than crashing.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Navigating elsewhere clears it without the user doing anything.
    view.rerender(<ErrorBoundary label="this view" resetKey="note-b"><Fragile broken={false} /></ErrorBoundary>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Kanban card is fine")).toBeInTheDocument();
  });

  it("removes a failed overlay instead of leaving it over the work, and reports it", () => {
    const onError = vi.fn();
    const { container } = render(
      <ErrorBoundary label="Import" fallback="none" resetKey={true} onError={onError}><Fragile broken /></ErrorBoundary>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(onError).toHaveBeenCalledWith("Import");
  });

  it("offers only a reload when the whole window failed", () => {
    render(<ErrorBoundary label="this window" fallback="window"><Fragile broken /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("Your saved library is not affected");
    expect(screen.getByRole("button", { name: "Reload window" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("copies bounded details for a report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ErrorBoundary label="this note"><Fragile broken /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(await screen.findByRole("button", { name: "Details copied" })).toBeInTheDocument();
    expect(writeText.mock.calls[0][0]).toContain("render: Error: Kanban card could not render");
  });
});

describe("problem diagnostics", () => {
  beforeEach(() => clearProblems());

  it("keeps a bounded number of bounded entries in memory only", () => {
    for (let index = 0; index < 50; index += 1) recordProblem("error", new Error(`problem ${index} ${"x".repeat(2_000)}`), "stack ".repeat(1_000));
    expect(recentProblems()).toHaveLength(30);
    expect(recentProblems()[0].message).toContain("problem 20");
    expect(recentProblems().every((problem) => problem.message.length <= 400 && (problem.detail?.length ?? 0) <= 1_500)).toBe(true);
    expect(describeProblems()).toContain("Orion problem report");
  });

  it("records uncaught errors and unhandled rejections without showing anything", () => {
    const remove = installGlobalProblemHandlers();
    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("undefined is not a function") }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = "The provider timed out.";
    window.dispatchEvent(rejection);
    expect(recentProblems().map((problem) => `${problem.kind}: ${problem.message}`)).toEqual([
      "error: TypeError: undefined is not a function",
      "rejection: The provider timed out.",
    ]);
    remove();
    // No error object: with no listener left, the test runner would otherwise
    // report a real one as an uncaught exception of the run.
    window.dispatchEvent(new ErrorEvent("error", { message: "after removal" }));
    expect(recentProblems()).toHaveLength(2);
  });
});
