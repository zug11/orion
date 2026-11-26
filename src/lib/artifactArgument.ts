import { list, literal, object } from "./artifactValidation";

type Claim = { id: string; text: string };
export type ArgumentPremise = Claim & { without: string } & (
  | { quote: string; unstated?: never }
  | { unstated: true; quote?: never }
);
export type ArgumentConclusion = Claim & { quote: string; supports: string[][] };
export interface ArtifactArgument {
  kind: "argument";
  passage: string;
  premises: ArgumentPremise[];
  conclusions: ArgumentConclusion[];
}

function claimId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value))
    throw new Error("An argument claim needs a short identifier.");
  return value;
}

export function parseArtifactArgument(raw: unknown): ArtifactArgument {
  const block = object(raw, ["kind", "passage", "premises", "conclusions"]);
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
  return { kind: "argument", passage, premises, conclusions };
}

export function evaluateArgument(block: ArtifactArgument, withheld: ReadonlySet<string>): Set<string> {
  const supported = new Set(block.premises.filter(p => !withheld.has(p.id)).map(p => p.id));
  for (const conclusion of block.conclusions) {
    if (conclusion.supports.some(group => group.every(id => supported.has(id))))
      supported.add(conclusion.id);
  }
  return supported;
}
