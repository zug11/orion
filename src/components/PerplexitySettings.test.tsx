// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PerplexitySettings } from "./PerplexitySettings";
import { defaultSettings } from "../data/defaults";
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

it("offers explicit OpenAI without deleting the Perplexity connection and shows the actual plan route", () => {
  const change = vi.fn(), provider = vi.fn();
  const settings = { ...defaultSettings, model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, perplexityApiKeyConfigured: true };
  const { rerender } = render(<PerplexitySettings configured onConfiguredChange={change} settings={settings} onProviderChange={provider}/>);
  expect(screen.getByText("Web research uses Perplexity.")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Web research provider" }), { target: { value: "openai" } });
  expect(provider).toHaveBeenCalledExactlyOnceWith("openai"); expect(deletePerplexityKey).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  rerender(<PerplexitySettings configured onConfiguredChange={change} settings={{ ...settings, webResearchProvider: "openai" }} onProviderChange={provider}/>);
  expect(screen.getByText("Web research uses ChatGPT plan.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove key" })).toBeInTheDocument();
});

it("explains an unavailable explicit OpenAI route while Anthropic remains selected", () => {
  render(<PerplexitySettings configured onConfiguredChange={vi.fn()} settings={{ ...defaultSettings, model: "claude-sonnet-5", apiKeyConfigured: true, perplexityApiKeyConfigured: true, webResearchProvider: "openai" }} onProviderChange={vi.fn()}/>);
  expect(screen.getByText("Choose an OpenAI or ChatGPT model under Intelligence to use OpenAI web search.")).toBeInTheDocument();
  expect(savePerplexityKey).not.toHaveBeenCalled(); expect(deletePerplexityKey).not.toHaveBeenCalled();
});
