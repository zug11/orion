// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { fetchWebPage, recognizeDocumentText } from "../lib/storage";
import type { ParsedImport } from "../types";
import {
  ImportStudio,
  type ImportStudioApplyPayload,
} from "./ImportStudio";

vi.mock("../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage")>();
  return {
    ...actual,
    fetchWebPage: vi.fn(),
    recognizeDocumentText: vi.fn(),
  };
});

const snapshot = createEmptySnapshot(
  "Import test Space",
  "2026-08-07T00:00:00.000Z",
);

function Harness({
  onApply = () => undefined,
}: {
  onApply?: (
    payload: ImportStudioApplyPayload,
  ) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open import
      </button>
      <ImportStudio
        open={open}
        snapshot={snapshot}
        onClose={() => setOpen(false)}
        onApply={onApply}
      />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parsedPage(title: string, url: string): ParsedImport {
  return {
    title,
    fileName: `${title.toLocaleLowerCase().replace(/\s+/g, "-")}.html`,
    mimeType: "text/html",
    format: "html",
    byteSize: 24,
    text: `${title} readable body`,
    warnings: [],
    sourceUrl: url,
  };
}

describe("Import unified intake", () => {
  beforeEach(() => {
    vi.mocked(fetchWebPage).mockReset();
    vi.mocked(recognizeDocumentText).mockReset();
  });

  it("uses one file affordance and a focused paste sheet", () => {
    render(<Harness />);

    expect(screen.getByRole("heading", { name: "Import" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose files, images, or media" }),
    );
    expect(
      screen.getByRole("heading", { name: "Choose a source" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Documents & images/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Audio or video/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close file choices" }));

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Field memo" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "A durable observation for this Space." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(screen.getByText("Field memo")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close import" }));
    expect(
      screen.queryByRole("heading", { name: "Import" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open import" }));
    expect(screen.getByText("Field memo")).toBeVisible();
  });

  it("queues multiple webpage fetches, preserves progress while closed, and ignores a late deleted result", async () => {
    const first = deferred<ParsedImport>();
    const second = deferred<ParsedImport>();
    vi.mocked(fetchWebPage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<Harness />);

    const input = screen.getByLabelText("Webpage or YouTube URL");
    fireEvent.change(input, {
      target: { value: "https://example.org/research" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
    expect(screen.getByText("Fetching readable webpage text…")).toBeVisible();

    fireEvent.change(input, {
      target: { value: "https://iana.org/domains" },
    });
    expect(screen.getByRole("button", { name: "Add URL" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
    expect(screen.getByText("2 sources")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close import" }));
    fireEvent.click(screen.getByRole("button", { name: "Open import" }));
    expect(screen.getByText("2 sources")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Remove example.org" }));
    await act(async () => {
      first.resolve(parsedPage("Removed page", "https://example.org/research"));
      await first.promise;
    });
    expect(screen.queryByText("Removed page")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(parsedPage("IANA domains", "https://iana.org/domains"));
      await second.promise;
    });
    await waitFor(() => expect(screen.getByText("IANA domains")).toBeVisible());
    expect(screen.getByText("1 source")).toBeVisible();
  });

  it("recognizes image text locally and ignores completion after removal", async () => {
    const first = deferred<Awaited<ReturnType<typeof recognizeDocumentText>>>();
    vi.mocked(recognizeDocumentText).mockReturnValueOnce(first.promise);
    const { container } = render(<Harness />);
    const input = container.querySelector<HTMLInputElement>(
      `input[type="file"][accept*=".png"]`,
    );
    expect(input).not.toBeNull();
    const image = new File([new Uint8Array([1, 2, 3])], "planning-board.png", {
      type: "image/png",
    });

    fireEvent.change(input!, { target: { files: [image] } });

    expect(screen.getByText("Recognizing text locally…")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove planning-board.png" }),
    );
    await act(async () => {
      first.resolve({
        text: "A whiteboard plan that finished too late",
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            text: "A whiteboard plan that finished too late",
          },
        ],
        warnings: [],
      });
      await first.promise;
    });

    expect(screen.queryByText("Planning Board")).not.toBeInTheDocument();
    expect(screen.queryByText("Import queue")).not.toBeInTheDocument();
  });

  it("clears the completed batch only after it is successfully applied", async () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "A short source ready to become a note." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Create notes" }));

    expect(
      await screen.findByRole("heading", { name: "1 page found" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add to Orion" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Open import" }));

    expect(screen.queryByText("Import queue")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review sources" })).toBeDisabled();
  });
});
