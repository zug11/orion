import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";
import { chatWithOrion } from "./storage";
import { generatePassageIllustration, generateVisualArtifact } from "./visualArtifactGeneration";
import { MAX_ARTIFACT_SOURCE } from "./visualArtifacts";

vi.mock("./storage", () => ({ chatWithOrion: vi.fn() }));
const transport = vi.mocked(chatWithOrion);
const settings = { model: "claude-sonnet-5", anthropicApiKeyConfigured: true, reasoningEffort: "low" } as Settings;
const gap = "\n\n[…]\n\n";
const conclusion = "The final inspection changed the limit to 37 litres.";
const prose = {kind:"text", text:conclusion};
const artifact = {version:1, format:"explainer", title:"Inspection", blocks:[prose]};
const reply = (data: unknown) => ({reply: JSON.stringify(data)});
const signal = () => new AbortController().signal;
beforeEach(() => { transport.mockReset(); });

describe("Visualise long selections", () => {
  it("covers over a million original characters and keeps a final correction through multiple reduction passes", async () => {
    const original = Array.from({length: 28_000}, (_, i) =>
      "Record " + i + " describes an interim inspection and its provisional reading. 🌱\n").join("") + conclusion;
    const readings: string[] = [];
    const progress = vi.fn();
    let final = "";
    transport.mockImplementation(async request => {
      const packet = JSON.parse(request.prompt);
      expect(packet.source.length).toBeLessThanOrEqual(MAX_ARTIFACT_SOURCE);
      expect(request).toMatchObject({notes:[],sources:[],concepts:[],history:[],allowNoteActions:false});
      if (!packet.readSelection) {
        final = packet.source;
        return reply(artifact);
      }
      readings.push(packet.source);
      const first = packet.source.split(gap)[0];
      const excerpt = (first.match(/Record \d+[^\n]*/u)?.index ?? 0);
      const quotes = [first.slice(excerpt, excerpt + 950)];
      if (packet.source.includes(conclusion) && !quotes[0].includes(conclusion)) quotes.push(conclusion);
      return reply({excerpts: quotes});
    });
    const result = await generateVisualArtifact(original, "explainer", "Follow corrections", settings, signal(),
      undefined, undefined, undefined, progress);
    const leaves = readings.filter(text => !text.includes(gap));
    let covered = 0;
    for (const leaf of leaves) {
      const start = original.indexOf(leaf, Math.max(0, covered - 250));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThanOrEqual(covered);
      expect(leaf).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      covered = start + leaf.length;
    }
    expect(covered).toBe(original.length);
    expect(progress.mock.calls.filter(([message]) => message.startsWith("Combining selection · group 1 of ")).length).toBeGreaterThan(1);
    expect(progress).toHaveBeenLastCalledWith("");
    expect(final).toContain(conclusion);
    expect(result).toEqual(artifact);
  });

  it("uses source-grounded excerpts for an explicit drawing and keeps its original selection out of the bounded drawing request", async () => {
    const source = "Inside the gauge is a float. ".repeat(730) + "At low pressure the valve closes.";
    const late = "At low pressure the valve closes.";
    const drawing = {kind:"illustration",view:"square",passage:late,parts:[{
      id:"valve", name:"Valve", selectable:true, about:late, quote:"valve closes",tone:"cool",
      shapes:[{type:"ellipse",cx:160,cy:140,rx:24,ry:18,paint:"outline"}],
    }]};
    transport.mockImplementation(async request => {
      const packet = JSON.parse(request.prompt);
      if (packet.readSelection) return reply({excerpts:[packet.source.includes(late) ? late : "Inside the gauge is a float."]});
      expect(packet.drawing).toBe(true);
      expect(packet.source).toContain(late);
      expect(packet.source.length).toBeLessThan(120);
      return reply({...artifact,blocks:[drawing]});
    });
    expect((await generatePassageIllustration(source, "", settings, signal())).blocks).toEqual([drawing]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("stops before making an artifact when a reader invents an excerpt", async () => {
    transport.mockResolvedValue(reply({excerpts:["invented words"]}));
    await expect(generateVisualArtifact("A field report. ".repeat(1800), "explainer", "", settings, signal()))
      .rejects.toThrow(/section .* failed.*verified excerpts/i);
    expect(transport.mock.calls.every(([request]) => JSON.parse(request.prompt).readSelection)).toBe(true);
  });

  it("aborts both readers and never dispatches the rest of a cancelled selection", async () => {
    const controller = new AbortController();
    let bothStarted!: () => void;
    const started = new Promise<void>(resolve => {bothStarted = resolve;});
    transport.mockImplementation((_request, reading) => new Promise((_resolve, reject) => {
      reading!.addEventListener("abort", () => reject(reading!.reason), {once:true});
      if (transport.mock.calls.length === 2) bothStarted();
    }));
    const result = generateVisualArtifact("One large source. ".repeat(12_000), "auto", "", settings, controller.signal);
    await started;
    controller.abort(new Error("Cancelled in the note"));
    await expect(result).rejects.toThrow("Cancelled in the note");
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
