import { list, literal, object } from "./artifactValidation";

type Claim = { id: string; text: string };
export type ArgumentPremise = Claim & { without: string } & (
  | { quote: string; unstated?: never }
  | { unstated: true; quote?: never }
);
export type ArgumentConclusion = Claim & { quote: string; supports: string[][] };
export type ArgumentParagraph = string | {
  variants: { requires: string[]; text: string }[];
  fallback: string | null;
};
export interface ArtifactArgument {
  kind: "argument";
  passage: string;
  premises: ArgumentPremise[];
  conclusions: ArgumentConclusion[];
  reading?: ArgumentParagraph[];
}

export class ArgumentReadingError extends Error {}

function claimId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value))
    throw new Error("An argument claim needs a short identifier.");
  return value;
}

function parseReading(raw: unknown, available: ReadonlySet<string>) {
  const reading = list<ArgumentParagraph>(raw, 1, 8, paragraph => {
    if (typeof paragraph === "string") return literal(paragraph, 1200);
    const value = object(paragraph, ["variants", "fallback"]);
    const conditions = new Set<string>();
    const variants = list(value.variants, 1, 8, item => {
      const variant = object(item, ["requires", "text"]);
      const requires = list(variant.requires, 1, 8, claimId);
      if (new Set(requires).size !== requires.length || requires.some(id => !available.has(id)))
        throw new ArgumentReadingError("A paragraph variant must name distinct premises or conclusions in this argument.");
      const condition = [...requires].sort().join(" ");
      if (conditions.has(condition)) throw new ArgumentReadingError("Use each combination of claims only once per paragraph.");
      conditions.add(condition);
      return { requires, text: literal(variant.text, 1200) };
    });
    const fallback = value.fallback === null ? null : literal(value.fallback, 1200);
    if (variants.every(variant => variant.text === fallback))
      throw new ArgumentReadingError("Write a different paragraph for a change in support, or keep fixed prose as a string.");
    return { variants, fallback };
  });
  if (reading.every(paragraph => typeof paragraph === "string"))
    throw new ArgumentReadingError("The argument reading needs at least one paragraph that changes with support.");
  return reading;
}

export function parseArtifactArgument(raw: unknown): ArtifactArgument {
  const block = object(raw, ["kind", "passage", "premises", "conclusions", "reading"]);
  if (block.kind !== "argument") throw new Error("Expected an argument.");
  const passage = literal(block.passage, 12000);
  const available = new Set<string>();

  function claim(value: Record<string, unknown>): Claim {
    const id = claimId(value.id);
    if (available.has(id)) throw new Error("Argument claims must have distinct identifiers.");
    return { id, text: literal(value.text, 500) };
  }
  function source(value: unknown): string {
    const quote = literal(value, 400);
    if (!passage.includes(quote)) throw new Error("An argument quote is missing from its passage.");
    return quote;
  }

  const premises = list<ArgumentPremise>(block.premises, 1, 8, rawPremise => {
    const value = object(rawPremise, ["id", "text", "quote", "without", "unstated"]);
    const base = { ...claim(value), without: literal(value.without, 500) };
    available.add(base.id);
    if ("unstated" in value) {
      if (value.unstated !== true || "quote" in value) throw new Error("An unstated assumption cannot carry a source quote.");
      return { ...base, unstated: true };
    }
    return { ...base, quote: source(value.quote) };
  });
  if (premises.every(premise => premise.unstated)) throw new Error("An argument needs a premise from its passage.");

  const conclusions = list<ArgumentConclusion>(block.conclusions, 1, 6, rawConclusion => {
    const value = object(rawConclusion, ["id", "text", "quote", "supports"]);
    const base = claim(value);
    const supports = list(value.supports, 1, 4, group => {
      const ids = list(group, 1, 8, claimId);
      if (new Set(ids).size !== ids.length || ids.some(id => !available.has(id)))
        throw new Error("Each support group must reference distinct premises or preceding conclusions.");
      return ids;
    });
    // Only earlier conclusions can be used as reasons, so the map is acyclic.
    available.add(base.id);
    return { ...base, quote: source(value.quote), supports };
  });
  const result: ArtifactArgument = { kind: "argument", passage, premises, conclusions };
  if (block.reading !== undefined) {
    try {
      result.reading = parseReading(block.reading, available);
    } catch (error) {
      if (error instanceof ArgumentReadingError) throw error;
      throw new ArgumentReadingError("Each adaptive paragraph needs variants with requires and text, and a fallback paragraph.");
    }
  }
  return result;
}

export function evaluateArgument(block: ArtifactArgument, withheld: ReadonlySet<string>): Set<string> {
  const supported = new Set(block.premises.filter(p => !withheld.has(p.id)).map(p => p.id));
  for (const conclusion of block.conclusions) {
    if (conclusion.supports.some(group => group.every(id => supported.has(id))))
      supported.add(conclusion.id);
  }
  return supported;
}

/** A more specific reading wins even if a model writes the broad case first.
 * Equal-length matches keep the author's order. Each paragraph resolves on its own. */
export function readArgumentParagraph(paragraph: ArgumentParagraph, supported: ReadonlySet<string>): string | null {
  if (typeof paragraph === "string") return paragraph;
  let mostRequired = 0;
  let reading = paragraph.fallback;
  for (const variant of paragraph.variants) {
    if (variant.requires.length > mostRequired && variant.requires.every(id => supported.has(id))) {
      mostRequired = variant.requires.length;
      reading = variant.text;
    }
  }
  return reading;
}

export function currentArgumentReading(block: ArtifactArgument, supported: ReadonlySet<string>): (string | null)[] {
  if (block.reading) return block.reading.map(paragraph => readArgumentParagraph(paragraph, supported));
  // Earlier v1 artifacts already carry the claims in the author's words. Only
  // put observations from stated premises and still-supported inferences in the reading.
  const conclusions = block.conclusions.filter(c => supported.has(c.id)).map(c => c.text);
  const evidence = block.premises.filter(p => !p.unstated && supported.has(p.id) && !conclusions.includes(p.text));
  return [evidence.map(p => p.text).join(" ") || null, conclusions.join(" ") || null];
}
