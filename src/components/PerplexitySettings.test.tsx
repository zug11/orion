// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PerplexitySettings } from "./PerplexitySettings";
import { deletePerplexityKey, savePerplexityKey, testPerplexityKey } from "../lib/perplexity";
vi.mock("../lib/perplexity", () => ({ deletePerplexityKey: vi.fn(), savePerplexityKey: vi.fn(), testPerplexityKey: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("only saves on request, clears the input and stores a non-secret status", async () => {
  const change = vi.fn();
  render(<PerplexitySettings configured={false} onConfiguredChange={change} />);
  expect(savePerplexityKey).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Perplexity API key"), { target: { value: "pplx-test-only" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(change).toHaveBeenCalledWith(true));
  expect(savePerplexityKey).toHaveBeenCalledWith("pplx-test-only");
  expect(screen.getByLabelText("Perplexity API key")).toHaveValue("");
  expect(testPerplexityKey).not.toHaveBeenCalled();
});
it("tests only on click, and a failed removal preserves the configured status", async () => {
  vi.mocked(testPerplexityKey).mockResolvedValue("Key accepted.");
  vi.mocked(deletePerplexityKey).mockRejectedValue(new Error("Keychain is locked."));
  const change = vi.fn();
  render(<PerplexitySettings configured onConfiguredChange={change} />);
  expect(testPerplexityKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Key accepted."));
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Keychain is locked."));
  expect(change).not.toHaveBeenCalled();
});
