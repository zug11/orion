import { describe, expect, it } from "vitest";
import { evaluateArtifactExpression, parseVisualArtifact, type ArtifactBlock, type ArtifactExpression } from "./visualArtifacts";

const mark = { kind: "path", d: "M 10,80 L 50 10 90 80 Z", fill: "cool", stroke: "ink" };
const rect = { kind: "rect", x: 10, y: 20, width: 75, height: 60, fill: "accent", stroke: "ink", level: true };
const scene = {
  kind: "scene",
  nodes: [
    { label: "Solar panel", alt: "Cells on a tilted panel", x: 18, y: 45, shapes: [
      { ...mark, d: "M 8 65 L 20 25 L 94 35 L 82 75 Z" },
      { ...mark, d: "M 17 45 L 88 55 M 48 29 L 36 69", fill: "none" }] },
    { label: "Battery", alt: "Storage cells", x: 50, y: 45, shapes: [rect] },
    { label: "Homes", alt: "A roof over a doorway", x: 82, y: 45, shapes: [mark] },
  ],
  frames: [
    { label: "Daylight", caption: "Panels power homes and charge the battery.", values: ["8 kW", "Charging · 2 kW", "6 kW"],
      levels: [null, 0.25, null], flows: [{ from: 0, to: 1, label: "2 kW" }, { from: 0, to: 2, label: "6 kW" }] },
    { label: "After sunset", caption: "Stored energy supplies the homes.", values: ["0 kW", "Discharging", "4 kW"],
      levels: [null, 0.15, null], flows: [{ from: 1, to: 2, label: "4 kW" }] },
  ],
};
const calculator = { kind: "calculator",
  inputs: [{ label: "Loaves", min: 1, max: 10, step: 1, initial: 2, unit: "" }],
  outputs: [{ label: "Flour", unit: "g", expression: { op: "multiply", left: { input: 0 }, right: 450 } }] };
const document = (block: unknown, format = "explainer") => ({ version: 1, format, title: "From the note", blocks: [block] });

describe("versioned visual documents", () => {
  it("round-trips original solar illustrations and changing flows", () => {
    const saved = document(scene);
    expect(parseVisualArtifact(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it.each([
    ["timeline", { kind: "steps", items: [{ label: "Second draft", heading: "Change viewpoint", text: "Mara narrates the final scene." }] }],
    ["comparison", { kind: "table", columns: ["Perspective", "First person", "Third person"], rows: [["Pronoun", "I", "She"]] }],
    ["quiz", { kind: "quiz", items: [{ question: "Which pigment did Mira mix?", choices: ["Ochre", "Indigo"], answer: 0, explanation: "She mixed ochre for the study." }] }],
    ["flashcards", { kind: "cards", items: [{ front: "Meaning of lento?", back: "Slowly." }] }],
    ["calculator", calculator],
    ["explainer", { kind: "text", text: "The refrain changes meaning on its second appearance." }],
  ])("supports a source-specific %s", (format, block) => {
    expect(parseVisualArtifact(document(block, format as string)).blocks).toEqual([block]);
  });
  it("accepts a comparison with an empty corner and populated row headings", () => {
    const table = { kind: "table", columns: ["", "First reading", "Rereading"],
      rows: [["Promise", "Reassurance", "Evasion"], ["Tone", "Tender", ""]] };
    expect(parseVisualArtifact(document(table, "comparison")).blocks).toEqual([table]);
    for (const header of ["", " "]) {
      expect(() => parseVisualArtifact(document({ ...table, columns: ["Aspect", header, "Rereading"] }))).toThrow();
      expect(() => parseVisualArtifact(document({ ...table, rows: [table.rows[0], [header, "Tender", ""]] }))).toThrow();
    }
    const named = { ...table, columns: ["Aspect", "First reading", "Rereading"], rows: [["", "Tender", ""]] };
    expect(parseVisualArtifact(document(named)).blocks).toEqual([named]);
  });
  it("computes quantities from a bounded formula and handles a zero denominator after adjustment", () => {
    const block = parseVisualArtifact(document(calculator, "calculator")).blocks[0] as Extract<ArtifactBlock, { kind: "calculator" }>;
    expect(evaluateArtifactExpression(block.outputs[0].expression, [3])).toBe(1350);
    expect(evaluateArtifactExpression({ op: "divide", left: 3, right: { input: 0 } }, [0])).toBeNull();
  });
  it("round-trips a fixed-payment calculator and recomputes from the chosen rate and term", () => {
    const payment: ArtifactExpression = {
      op: "periodicPayment",
      principal: { input: 0 },
      ratePerPeriod: { op: "divide", left: { input: 1 }, right: 1200 },
      periods: { op: "multiply", left: { input: 2 }, right: 12 },
    };
    const saved = document({ kind: "calculator", inputs: [
      { label: "Principal", unit: "$", min: 0, max: 500000, step: 1000, initial: 400000 },
      { label: "Annual rate", unit: "%", min: 0, max: 12, step: 0.25, initial: 6 },
      { label: "Term", unit: "years", min: 1, max: 30, step: 1, initial: 30 },
    ], outputs: [{ label: "Monthly payment", unit: "$/month", expression: payment }] }, "calculator");
    expect(parseVisualArtifact(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(evaluateArtifactExpression(payment, [400000, 6, 30])).toBeCloseTo(2398.202100611010, 9);
    expect(evaluateArtifactExpression(payment, [400000, 6, 15])).toBeCloseTo(3375.427312193805, 9);
    expect(evaluateArtifactExpression(payment, [400000, 3, 30])).toBeCloseTo(1686.416134917802, 9);
    expect(evaluateArtifactExpression(payment, [400000, 0, 30])).toBe(400000 / 360);
    expect(evaluateArtifactExpression(payment, [400000, 1e-12, 30])).toBeCloseTo(1111.111111111278, 10);
    expect(evaluateArtifactExpression(payment, [0, 6, 30])).toBe(0);
  });
  it("rejects invalid periodic-payment operands and preserves the existing expression budget", () => {
    const payment = { op: "periodicPayment", principal: 1000, ratePerPeriod: 0.01, periods: 12 } as const;
    const parse = (expression: unknown) => parseVisualArtifact(document({
      ...calculator, outputs: [{ label: "Payment", unit: "$", expression }],
    }, "calculator"));
    for (const changes of [{ principal: -1 }, { ratePerPeriod: -0.01 }, { periods: 0 }, { periods: 1.5 },
      { periods: { op: "divide", left: 1, right: 0 } as const }]) {
      expect(evaluateArtifactExpression({ ...payment, ...changes }, [])).toBeNull();
      expect(() => parse({ ...payment, ...changes })).toThrow();
    }
    expect(() => parse({ ...payment, left: 1 })).toThrow();
    expect(() => parse({ ...payment, ratePerPeriod: undefined })).toThrow();
    expect(() => parse({ ...payment, periods: { input: 1 } })).toThrow();
    let branch: ArtifactExpression = 1;
    for (let depth = 0; depth < 4; depth++) branch = { op: "add", left: branch, right: branch };
    expect(() => parse({ op: "add", left: branch, right: branch })).not.toThrow(); // 63 nodes
    expect(() => parse({ ...payment, principal: branch, periods: branch })).toThrow(); // 64 nodes
  });
  it.each([
    { ...rect, onclick: "handler" }, { ...rect, fill: "url(asset)" }, { ...rect, height: 100 }, { ...rect, level: 42 },
    { ...mark, d: "M -20 20" }, { ...mark, d: "M 18 18 C 20 40" }, { ...mark, d: "M 20 10 L" },
    { ...mark, d: "M 100 101" }, { ...mark, d: "M 12,,20" }, { ...mark, d: "M 12 20 <use>" },
    { ...mark, d: "M 1 1" + " L 2 2".repeat(66) }, { kind: "image", href: "external" },
  ])("rejects geometry outside the drawing vocabulary", shape => {
    expect(() => parseVisualArtifact(document({ ...scene, nodes: scene.nodes.map(node => ({ ...node, shapes: [shape] })) }))).toThrow();
  });
  it.each([
    { ...scene.frames[0], levels: [null] }, { ...scene.frames[0], values: ["one", "two"] },
    { ...scene.frames[0], flows: [{ from: 0, to: 99, label: "" }] }, { ...scene.frames[0], levels: [null, 100, null] },
  ])("rejects frames that cannot bind to their diagram", frame => {
    expect(() => parseVisualArtifact(document({ ...scene, frames: [frame] }))).toThrow();
  });
  it("rejects an unknown block, a mismatched primary interaction, excessive size and deep formulas", () => {
    expect(() => parseVisualArtifact(document({ kind: "html", text: "..." }))).toThrow();
    expect(() => parseVisualArtifact(document({ kind: "text", text: "A recipe" }, "quiz"))).toThrow();
    const large = { kind: "table", columns: ["A","B","C"], rows: Array.from({ length: 24 }, () => Array(3).fill("字".repeat(400))) };
    expect(() => parseVisualArtifact(document(large))).toThrow();
    let expr: unknown = 2;
    for (let i = 0; i < 12; i++) expr = { op: "add", left: expr, right: 0 };
    for (const bad of [expr, { input: 1 }, { op: "arbitrary", left: 4, right: 2 }, NaN]) {
      expect(() => parseVisualArtifact(document({ ...calculator, outputs: [{ label: "Result", unit: "", expression: bad }] }))).toThrow();
    }
    expect(() => parseVisualArtifact(document({ ...calculator, inputs: [{ ...calculator.inputs[0], initial: 1.25 }] }))).toThrow();
  });
});
