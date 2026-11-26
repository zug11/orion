import { createContext, useContext, useState } from "react";
import type { ArtifactEvidence, EvidenceField } from "../lib/visualArtifacts";

export interface EvidenceLinks { block: number; evidence: ArtifactEvidence; panelId: string }
export const EvidenceLinksContext = createContext<EvidenceLinks | undefined>(undefined);

export function FactSource({field, index}: {field: EvidenceField; index: number}) {
  const links = useContext(EvidenceLinksContext);
  if (!links) return null;
  const number = links.evidence.claims.findIndex(({target}) => target?.block === links.block && target.field === field && target.index === index);
  if (number === -1) return null;
  const claim = links.evidence.claims[number];
  const found = claim.quotes.length > 0 && claim.quotes.every(q => links.evidence.passage.includes(q));
  return <button type="button" className="va-source-link" aria-label={"Source for " + claim.label}
    onClick={event => {
      const panel = event.currentTarget.ownerDocument.getElementById(links.panelId) as HTMLDetailsElement | null;
      if (!panel) return;
      panel.open = true;
      panel.querySelector<HTMLButtonElement>(`[data-source-claim="${number}"]`)?.focus();
    }}>{found ? "Source" : "Missing source"}</button>;
}

function highlightedPassage(passage: string, quotes: string[]) {
  // A short quote may repeat throughout a long passage. Count interval
  // boundaries so overlapping quotes cost at most one array per passage.
  const boundaries = new Int32Array(passage.length + 1);
  for (const quote of new Set(quotes)) {
    if (!quote) continue;
    let start = passage.indexOf(quote);
    while (start !== -1) {
      boundaries[start]++;
      boundaries[start + quote.length]--;
      start = passage.indexOf(quote, start + 1);
    }
  }
  const text = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= passage.length; i++) {
    const nextDepth = depth + boundaries[i];
    if (depth === 0 && nextDepth > 0) {
      text.push(passage.slice(start, i));
      start = i;
    } else if (depth > 0 && nextDepth === 0) {
      text.push(<mark key={start}>{passage.slice(start, i)}</mark>);
      start = i;
    }
    depth = nextDepth;
  }
  return [...text, passage.slice(start)];
}

export function ArtifactEvidenceView({ evidence, id }: { evidence: ArtifactEvidence; id: string }) {
  const [active, setActive] = useState<number | "all">("all");
  const { passage, claims } = evidence;
  const quotes = active === "all" ? claims.flatMap(claim => claim.quotes) : claims[active].quotes;
  return <details id={id} className="va-evidence">
    <summary>Sources in the passage</summary>
    <ul>{claims.map((claim, i) => {
      const matches = claim.quotes.filter(quote => passage.includes(quote)).length;
      return <li key={i}><button type="button" data-source-claim={i} aria-pressed={active === i}
        onFocus={() => setActive(i)} onPointerEnter={() => setActive(i)} onClick={() => setActive(i)}>
        {claim.label}
        {(!matches || matches < claim.quotes.length) && <small> · {matches ? "Some excerpts missing" : "No matching excerpt"}</small>}
      </button></li>;
    })}</ul>
    <button type="button" aria-pressed={active === "all"} onClick={() => setActive("all")}>Show every source</button>
    <blockquote>{highlightedPassage(passage, quotes)}</blockquote>
  </details>;
}
