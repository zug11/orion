// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { runChatReading } from "./chatReading";
import { applyChatResult, buildChatRequest, saveChatReplyAsNote } from "./chat";
import { chatVisualSuggestion } from "./chatVisualIntent";
import drawings from "./fixtures/mcpVisualDrawingDynamics.json";
import { finishChatVisual } from "./chatVisual";
import { readVisualProviderStream, streamedVisualPreview } from "./chatVisualStream";
import { readVisualArtifactMarker } from "./visualArtifactMarkdown";
import { saveApiKey, deleteApiKey, saveAnthropicApiKey, deleteAnthropicApiKey } from "./storage";

const now = "2026-11-26T09:00:00.000Z";
const source = "The plant grows a leaf, then a flower.";
const answer = { reply: "A leaf appears first.", visualFormat: "explainer" as const };
const artifact = { version: 1, format: "explainer", title: "Leaf to flower", blocks: [
  { kind: "text", heading: 'A "leaf"', text: "The leaf grows." },
  { kind: "steps", items: [{ label: "Afterwards", heading: "Flower", text: "The flower opens." }] },
] };
const envelope = JSON.stringify({ reply: JSON.stringify(artifact) });
const frame = (event: unknown) => new TextEncoder().encode("data: " + JSON.stringify(event) + "\r\n\r\n");
afterEach(async () => { vi.unstubAllGlobals(); await deleteApiKey(); await deleteAnthropicApiKey(); });

describe("Chat visual streaming", () => {
  it("lets typed Chat recommend a visual and removes the private format hint from the cited answer", async () => {
    const space = createEmptySnapshot("Garden", now, "garden");
    const result = await runChatReading(space, "How does it develop?", async request => {
      expect(JSON.parse(request.readingContext!).inlineVisuals).toBe(true);
      return { reply: "A leaf appears first.\n\n[[visualise:explainer]]" };
    }, { inlineVisuals: true });
    expect(result).toMatchObject(answer);
  });
  it("shows a real heading, then complete validated blocks even when the nested JSON is split mid-string", () => {
    const heading = vi.fn();
    const cut = envelope.indexOf("Afterwards");
    const first = streamedVisualPreview(envelope.slice(0, cut + 2), heading);
    expect(heading).toHaveBeenCalledWith(expect.objectContaining({ title: artifact.title }));
    expect(first?.blocks).toEqual([artifact.blocks[0]]);
    expect(streamedVisualPreview(envelope.replace('"reply"', '"other"'))).toBeUndefined();
    const malformed = { ...artifact, blocks: [{ kind: "bad" }, artifact.blocks[1]] };
    expect(streamedVisualPreview(JSON.stringify({ reply: JSON.stringify(malformed) }))).toBeUndefined();
  });

  it.each(["openai", "anthropic"] as const)("advances %s previews from incoming SSE bytes, then keeps the final interactive document with the note", async provider => {
    const snapshot = createEmptySnapshot("Garden", now, "garden");
    const anthropic = provider === "anthropic";
    snapshot.settings.model = anthropic ? "claude-sonnet-5" : "gpt-5.6-sol";
    snapshot.settings.apiKeyConfigured = true;
    snapshot.settings.anthropicApiKeyConfigured = true;
    if (anthropic) await saveAnthropicApiKey("synthetic-test-key"); else await saveApiKey("synthetic-test-key");
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
      { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const onPreview = vi.fn();
    const result = finishChatVisual(answer, "How does it develop?", source, false, snapshot.settings,
      new AbortController().signal, onPreview);
    expect(onPreview).toHaveBeenCalledWith({ answer });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    if (anthropic) stream.enqueue(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    const consume = (delta: string) => stream.enqueue(frame(anthropic ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } : { type: "response.output_text.delta", delta }));
    const cut = envelope.indexOf("Afterwards");
    consume(envelope.slice(0, cut));
    await vi.waitFor(() => expect(onPreview.mock.calls.some(([item]) => item.artifact?.blocks.length === 1)).toBe(true));
    consume(envelope.slice(cut));
    if (anthropic) {
      stream.enqueue(frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }));
      stream.enqueue(frame({ type: "message_stop" }));
    } else {
      stream.enqueue(frame({ type: "response.completed", response: { status: "completed", output_text: envelope } }));
    }
    stream.close();
    const received = await result;
    expect(received.reply).toBe("A leaf appears first.");
    expect(readVisualArtifactMarker(received.visualArtifact)).toEqual(artifact);
    let id = 0;
    const saved = applyChatResult(snapshot, "How does it develop?", received, now, () => String(++id));
    const context = buildChatRequest(saved, "What is the second stage?").history;
    expect(context[1].content).toContain("Leaf to flower");
    expect(context[1].content).not.toContain("orion-artifact");
    const restored = JSON.parse(JSON.stringify(saved));
    const kept = saveChatReplyAsNote(restored, "2", now, "new-note");
    expect(kept.notes[0].body).toContain(received.visualArtifact);
    expect(kept.studio.messages[1].content).toBe(received.reply);
  });

  it("routes a literal SVG drawing request through the geometry generator, streams only current evidence and labels answer-derived visuals", async () => {
    const snapshot = createEmptySnapshot("Garden", now, "garden");
    snapshot.settings.apiKeyConfigured = true;
    await saveApiKey("synthetic-test-key");
    const drawing = { kind: "illustration", view: "square", passage: source, parts: [
      { id: "leaf", name: "Leaf", about: "First stage", quote: "a leaf", selectable: true, tone: "warm",
        shapes: [{ type: "ellipse", paint: "outline", cx: 200, cy: 200, rx: 50, ry: 30 }] },
    ] };
    const fetch = vi.fn(async (_url: RequestInfo | URL, opts?: RequestInit) => {
      if (String(_url).endsWith("/models")) return Response.json({data:[{id:"gpt-6.2-astra"}]});
      const body = JSON.parse(opts!.body as string);
      expect(body.model).toBe("gpt-6.2-astra");
      const input = JSON.parse(body.input);
      expect(input.drawing).toBe(true);
      expect(input.source).toContain(source);
      expect(input.source).not.toContain("Some other wording from the assistant");
      const text = JSON.stringify({ reply: JSON.stringify({ ...artifact, blocks: [drawing] }) });
      return new Response(frame({ type: "response.completed", response: { status: "completed", output_text: text } }));
    });
    vi.stubGlobal("fetch", fetch);
    const result = await finishChatVisual({ reply: "Some other wording from the assistant", evidence: [{ kind: "note", text: source, id: "e1", entityId: "plant", version: "1", start: 0, end: source.length, title: "Growth", offsetUnit: "utf16" }] },
      "Could you draw an SVG of the leaf?", undefined, false, snapshot.settings, new AbortController().signal, () => {});
    expect(readVisualArtifactMarker(result.visualArtifact)?.blocks[0]).toEqual(drawing);
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, opts?: RequestInit) => {
      const input = JSON.parse(JSON.parse(opts!.body as string).input);
      expect(input.source).toBe("Previous Chat reply\n" + source);
      return new Response(frame({ type: "response.completed", response: { status: "completed", output_text: envelope } }));
    }));
    const followup = await finishChatVisual({ reply: "Here's the visual.", visualFormat: "explainer" }, "Visualise your last answer", undefined,
      false, snapshot.settings, new AbortController().signal, () => {}, source);
    expect(readVisualArtifactMarker(followup.visualArtifact)?.summary).toContain("previous Chat reply");
  });

  it("preserves the answer on an incomplete stream and keeps unfinished data out of history", async () => {
    const snapshot = createEmptySnapshot("Garden", now, "garden");
    snapshot.settings.apiKeyConfigured = true;
    await saveApiKey("synthetic-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frame({ type: "response.output_text.delta", delta: envelope }))));
    const reply = await finishChatVisual(answer, "A question", source, false, snapshot.settings, new AbortController().signal, () => {});
    expect(reply.reply).toBe("A leaf appears first.");
    expect(reply.visualError).toMatch(/stream/);
    expect(reply.visualArtifact).toBeUndefined();
    await expect(readVisualProviderStream(new Response(frame({ type: "message_stop" })), "anthropic", () => {})).rejects.toThrow();
  });

  it.each(["Animate the bridge opening cycle", "Show me an animated drawing of the bridge"])(
    "treats an explicit request as an animation even without the Chat visual toggle: %s", async prompt => {
      const settings = createEmptySnapshot("Harbour", now, "harbour").settings;
      settings.apiKeyConfigured = true;
      await saveApiKey("synthetic-test-key");
      const visual = drawings[1].artifact;
      const passage = visual.blocks[0].passage;
      const packets: unknown[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
        if (String(url).endsWith("/models")) return Response.json({data:[{id:"gpt-6.2-astra"}]});
        packets.push(JSON.parse(JSON.parse(opts!.body as string).input));
        const reply = JSON.stringify({reply: JSON.stringify(visual)});
        return new Response(frame({type: "response.completed", response: {status: "completed", output_text: reply}}));
      }));
      const result = await finishChatVisual({reply: "The bridge opens."}, prompt, passage, false,
        settings, new AbortController().signal, () => {});
      expect(packets).toEqual([expect.objectContaining({source: passage, drawing: true, interaction: "play"})]);
      expect(readVisualArtifactMarker(result.visualArtifact)).toEqual(visual);
    });

  it.each(["selection", "attached note"] as const)("reads the final section of a long %s and streams reading progress", async origin => {
    const settings = createEmptySnapshot("Garden", now, "garden").settings;
    settings.apiKeyConfigured = true;
    await saveApiKey("synthetic-test-key");
    const first = "First observation.";
    const last = "The final observation mentions a flower.";
    const passage = first + "\n" + "An earlier observation. ".repeat(700) + "\n" + last;
    const note = { id: "plant", title: "Field notes", slug: "field-notes", summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [],
      kind: "article" as const, status: "ready" as const, createdAt: now, updatedAt: now,
      body: origin === "selection" ? "Outside the requested selection." : passage + "\n\n- [x] Completed private work\n<!-- private marker -->" };
    const reads: string[] = [];
    const final: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, opts?: RequestInit) => {
      const input = JSON.parse(JSON.parse(opts!.body as string).input);
      if (input.readSelection) {
        reads.push(input.source);
        const quote = input.source.includes(first) ? first : last;
        return Response.json({ status: "completed", output_text: JSON.stringify({ reply: JSON.stringify({ excerpts: [quote] }) }) });
      }
      final.push(input.source);
      return new Response(frame({ type: "response.completed", response: { status: "completed", output_text: envelope } }));
    }));
    const update = vi.fn();
    const result = await finishChatVisual(answer, "Visualise the attached note", origin === "selection" ? passage : undefined,
      true, settings, new AbortController().signal, update, undefined, note);
    expect(result.visualError).toBeUndefined();
    expect(readVisualArtifactMarker(result.visualArtifact)).toEqual(artifact);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.some(piece => piece.includes(last))).toBe(true);
    expect(reads.join("")).not.toMatch(/Completed private work|private marker|Outside the requested selection/);
    expect(final).toHaveLength(1);
    expect(final[0]).toContain(last);
    expect(update.mock.calls.some(([preview]) => preview.progress?.includes("section"))).toBe(true);
  });

  it("keeps the end of a pasted Chat prompt and excludes a focused note unless the user refers to it", async () => {
    const settings = createEmptySnapshot("Garden", now, "garden").settings;
    settings.apiKeyConfigured = true;
    await saveApiKey("synthetic-test-key");
    const note = { id: "other", title: "Unrelated", body: "Unrelated focused note text.", slug: "other", summary: "", aliases: [],
      tags: [], sourceIds: [], conceptIds: [], kind: "article" as const, status: "ready" as const, createdAt: now, updatedAt: now };
    const prompt = "Visualise the following passage.\n" + "Sentence. ".repeat(760) + "This is the final fact.";
    const inputs: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, opts?: RequestInit) => {
      inputs.push(JSON.parse(JSON.parse(opts!.body as string).input).source);
      return new Response(frame({ type: "response.completed", response: { status: "completed", output_text: envelope } }));
    }));
    const result = await finishChatVisual(answer, prompt, undefined, true, settings, new AbortController().signal, () => {}, undefined, note);
    expect(result.visualError).toBeUndefined();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain(prompt);
    expect(inputs[0]).not.toContain(note.body);
  });

  it("avoids spending another request on ordinary text, and ignores unknown formats", async () => {
    const result = { reply: "Written answer." };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const settings = createEmptySnapshot("Garden", now, "garden").settings;
    expect(await finishChatVisual(result, "Explain briefly", "", false, settings, new AbortController().signal, () => {})).toEqual(result);
    expect(chatVisualSuggestion("Body\n\n[[visualise:external]]")).toEqual({ reply: "Body" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
