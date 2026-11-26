// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { generatePassageIllustration } from "./visualArtifactGeneration";
import { validatedVisualReview } from "./visualReviewInput";
import { saveApiKey, saveAnthropicApiKey, deleteApiKey, deleteAnthropicApiKey } from "./storage";
import { parseArtifactIllustration, type ArtifactIllustration } from "./artifactIllustration";
import fixtures from "./fixtures/mcpVisualDrawingDynamics.json";
import { reviewPassageIllustration } from "./visualArtifactReview";

const raster = vi.hoisted(() => vi.fn());
vi.mock("./rasteriseArtifactIllustration", () => ({ rasteriseArtifactIllustration: raster }));
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const source = "The clock has a face.";
const drawing: ArtifactIllustration = { kind: "illustration", view: "square", passage: source, parts: [
  { id: "face", name: "Face", tone: "neutral", selectable: true, about: "The face of the clock.", quote: "a face",
    shapes: [{ type: "circle", cx: 125, cy: 125, r: 25, paint: "outline" }] },
] };
const draft = { version: 1, format: "explainer", title: "Clock", blocks: [drawing] };
afterEach(async () => { await deleteApiKey(); await deleteAnthropicApiKey(); vi.unstubAllGlobals(); raster.mockReset(); });

function settings(anthropic = false) {
  const options = createEmptySnapshot("Clock", "2026-11-26", "space").settings;
  return { ...options, apiKeyConfigured: true, anthropicApiKeyConfigured: true, model: anthropic ? "claude-sonnet-5" : "gpt-5.6-sol" };
}
function mockModel(revision: unknown, anthropic = false) {
  let i = 0;
  const fetch = vi.fn(async (_url: RequestInfo | URL, _opts?: RequestInit) => {
    const text = JSON.stringify({ reply: JSON.stringify(i++ ? revision : draft) });
    return new Response(JSON.stringify(anthropic ? { stop_reason: "end_turn", content: [{ type: "text", text }] } : { status: "completed", output_text: text }));
  });
  vi.stubGlobal("fetch", (url: RequestInfo | URL, opts?: RequestInit) =>
    String(url).endsWith("/models") ? Promise.resolve(Response.json({ data: [{ id: "gpt-6.2-astra" }] })) : fetch(url, opts));
  return fetch;
}

describe("optional look-and-fix drawing pass", () => {
  it("can improve contours after reviewing poses but preserves handles and the entire animation", async () => {
    await saveApiKey("synthetic-test");
    const original = parseArtifactIllustration(fixtures[1].artifact.blocks[0]);
    raster.mockResolvedValue(png);
    const review = (value: unknown) => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({status:"completed",output_text:JSON.stringify({reply:JSON.stringify(value)})})));
      return reviewPassageIllustration({version:1,format:"explainer",title:"Bridge",blocks:[original]},original,original.passage,"",settings(),new AbortController().signal);
    };
    const changed = structuredClone(original);
    changed.parts[0].layer = -3;
    expect((await review(changed)).blocks[0]).toEqual(changed);
    const modified = structuredClone(changed);
    modified.handles![0].label = "Other control";
    await expect(review(modified)).rejects.toThrow(/changed parts/);
    delete changed.animation;
    await expect(review(changed)).rejects.toThrow(/changed parts/);
  });
  it.each([true, false])("sends the local PNG, selected passage and validated draft to the selected connection (Anthropic=%s)", async anthropic => {
    await saveApiKey("synthetic-test"); await saveAnthropicApiKey("synthetic-test");
    raster.mockResolvedValue(png);
    const revised = structuredClone(drawing);
    revised.parts[0].shapes = [{ type: "circle", cx: 220, cy: 210, r: 50, paint: "outline" }];
    const fetch = mockModel(revised, anthropic);
    const reviewed = await generatePassageIllustration(source, "", settings(anthropic), new AbortController().signal, { review: true });
    expect(reviewed.blocks[0]).toEqual(revised);
    expect(fetch).toHaveBeenCalledTimes(2);
    const initial = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(JSON.stringify(initial)).not.toContain("image/png");
    const wire = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(wire.model).toBe(anthropic ? "claude-sonnet-5" : "gpt-6.2-astra");
    expect(initial.model).toBe(wire.model);
    if (!anthropic) expect(wire.reasoning.effort).toBe("high");
    const content = anthropic ? wire.messages[0].content : wire.input[0].content;
    expect(anthropic ? content[1].source.data : content[1].image_url).toEqual(anthropic ? png.split(",")[1] : png);
    expect(JSON.parse(content[0].text)).toMatchObject({ source, drawingToReview: drawing });
    expect(JSON.stringify(wire)).not.toContain("workspaceName");
  });
  it("retains the valid draft on unsupported review output or lost identity and skips review by default", async () => {
    await saveApiKey("synthetic-test");
    raster.mockResolvedValue(png);
    const bad = { ...drawing, parts: [{ ...drawing.parts[0], name: "Not the face" }] };
    const fetch = mockModel(bad);
    const fallback = vi.fn();
    expect(await generatePassageIllustration(source, "", settings(), new AbortController().signal, { review: true, onReviewFallback: fallback })).toEqual(draft);
    expect(fallback).toHaveBeenCalledWith(expect.stringContaining("changed parts"));
    expect(fetch).toHaveBeenCalledTimes(2);
    const single = mockModel({ unchanged: true });
    expect(await generatePassageIllustration(source, "", settings(), new AbortController().signal)).toEqual(draft);
    expect(single).toHaveBeenCalledTimes(1);
  });
  it("rejects cancellation during rasterization and refuses a URL, oversized dimensions or unrelated passage", async () => {
    await saveApiKey("synthetic-test");
    const controller = new AbortController();
    raster.mockImplementation(() => { controller.abort(new Error("stopped")); return Promise.resolve(png); });
    const fetch = mockModel({ unchanged: true });
    await expect(generatePassageIllustration(source, "", settings(), controller.signal, { review: true })).rejects.toThrow("stopped");
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const url of ["https://example.test/figure.png", "file:///tmp/figure.png", "data:image/svg+xml,<svg/>"]) {
      expect(() => validatedVisualReview({ drawing, png: url }, source)).toThrow(/PNG/);
    }
    expect(() => validatedVisualReview({ drawing, png }, "Different source")).toThrow();
    const bytes = atob(png.split(",")[1]); const oversized = bytes.slice(0,16) + "\x00\x00\x04\x00" + bytes.slice(20);
    expect(() => validatedVisualReview({ drawing, png: "data:image/png;base64," + btoa(oversized) }, source)).toThrow(/960/);
  });
});
