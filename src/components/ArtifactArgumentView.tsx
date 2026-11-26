import { useId, useState } from "react";
import { currentArgumentReading, evaluateArgument, type ArtifactArgument, type ArgumentConclusion } from "../lib/artifactArgument";
import "./ArtifactArgumentView.css";

type Props = { block: ArtifactArgument };

function claimLabels(block: ArtifactArgument) {
  const labels = new Map<string, string>();
  block.premises.forEach((p, index) => labels.set(p.id, (p.unstated ? "Unstated premise " : "Premise ") + (index + 1)));
  block.conclusions.forEach((c, index) => labels.set(c.id, "Conclusion " + (index + 1)));
  return labels;
}

function supportDescription(conclusion: ArgumentConclusion, labels: Map<string, string>) {
  return conclusion.supports.map(group => {
    const names = group.map(id => labels.get(id)).join(" + ");
    return group.length > 1 && conclusion.supports.length > 1 ? "(" + names + ")" : names;
  }).join(" or ");
}

function SourceExcerpt({ label, passage, quote }: { label: string; passage: string; quote: string }) {
  const at = passage.indexOf(quote);
  // Show the claim's actual location, with a little context even in a long note.
  const before = Array.from(passage.slice(0, at));
  const after = Array.from(passage.slice(at + quote.length));
  const context = passage.length <= 400 ? 400 : 100;
  return <div className="va-arg-source" aria-label={"Passage for " + label.toLowerCase()}>
    <blockquote>{before.length > context && "…"}{before.slice(-context).join("")}
      <mark>{quote}</mark>{after.slice(0, context).join("")}{after.length > context && "…"}</blockquote>
    {(before.length > context || after.length > context) && <details>
      <summary>Full passage</summary>
      <blockquote>{passage.slice(0, at)}<mark>{quote}</mark>{passage.slice(at + quote.length)}</blockquote>
    </details>}
  </div>;
}

export function ArtifactArgumentView({ block }: Props) {
  const [withheld, setWithheld] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string>();
  const prefix = useId();
  const labels = claimLabels(block);
  const supported = evaluateArgument(block, withheld);
  const reading = currentArgumentReading(block, supported);
  const supportedCount = block.conclusions.filter(c => supported.has(c.id)).length;

  function toggle(id: string) {
    setWithheld(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function sourceButton(id: string) {
    return <button type="button" className="va-arg-source-toggle" aria-expanded={selected === id}
      aria-label={"Source for " + labels.get(id)!.toLowerCase()} aria-controls={prefix + id}
      onClick={() => setSelected(selected === id ? undefined : id)}>Source</button>;
  }
  function sourcePanel(id: string, quote: string) {
    return <div id={prefix + id} hidden={selected !== id}>{selected === id &&
      <SourceExcerpt label={labels.get(id)!} passage={block.passage} quote={quote} />}</div>;
  }

  const supportCountLabel = supportedCount + " of " + block.conclusions.length + " " +
    (block.conclusions.length === 1 ? "conclusion" : "conclusions") + " supported by the granted premises";
  const conclusions = <section aria-label="Conclusions" className="va-arg-conclusions">
    {block.conclusions.map(c => <div key={c.id} className="va-arg-conclusion" data-supported={supported.has(c.id)}>
      <div className="va-arg-caption">{labels.get(c.id)} <span className="va-arg-status">
        {supported.has(c.id) ? "Supported" : "Support withdrawn"}
      </span></div>
      <p>{supported.has(c.id) ? c.text : <>The remaining premises leave this claim open. <q>{c.text}</q></>}</p>
      <div className="va-arg-support"><span>{supportDescription(c, labels)}</span>{sourceButton(c.id)}</div>
      {sourcePanel(c.id, c.quote)}
    </div>)}
  </section>;

  return <div className="va-argument">
    <section aria-label="Current reading" className="va-arg-reading">
      <h4>Current reading</h4>
      <div aria-live="polite" aria-relevant="all">{reading.some(text => text !== null)
        ? reading.map((text, i) => text !== null && <p key={i}>{text}</p>)
        : <p>The remaining premises leave the argument open.</p>}</div>
    </section>
    <section aria-label="Premises" className="va-arg-premises">
      {block.premises.map(p => <div key={p.id} className="va-arg-premise" data-withheld={withheld.has(p.id)} data-unstated={p.unstated}>
        <span className="va-arg-caption">{labels.get(p.id)}</span>
        <p id={prefix + "premise-text-" + p.id}>{p.text}</p>
        <div className="va-arg-controls">
          <button type="button" role="switch" aria-checked={!withheld.has(p.id)}
            aria-label={"Grant " + labels.get(p.id)!.toLowerCase()}
            aria-describedby={prefix + "premise-text-" + p.id}
            className="va-arg-grant" onClick={() => toggle(p.id)}>
            <span className="va-arg-track" aria-hidden="true" />{withheld.has(p.id) ? "Withheld" : "Granted"}
          </button>
          {p.quote && sourceButton(p.id)}
        </div>
        {p.quote && sourcePanel(p.id, p.quote)}
        {withheld.has(p.id) && <p className="va-arg-without">{p.without}</p>}
      </div>)}
    </section>
    {block.reading ? <details className="va-arg-reasoning">
      <summary>{supportCountLabel}</summary>
      {conclusions}
    </details> : <>{conclusions}<div className="va-arg-summary" role="status">{supportCountLabel}</div></>}
  </div>;
}

export function ArtifactArgumentSnapshot({ block }: Props) {
  const labels = claimLabels(block);
  const supported = evaluateArgument(block, new Set());
  return <section>
    <h4>Reading with all premises granted</h4>
    {currentArgumentReading(block, supported).map((text, i) => text !== null && <p key={i}>{text}</p>)}
    {block.reading && <>
      <h4>How the reading changes</h4>
      <p>For each paragraph, choose the version with the longest list of supported claims. Use the first listed in a tie.</p>
      {block.reading.map((paragraph, i) => typeof paragraph === "string" ? null : <div key={i}>
        <h5>Paragraph {i + 1}</h5>
        <ol>{paragraph.variants.map((variant, j) => <li key={j}>
          <strong>{variant.requires.map(id => labels.get(id)).join(" + ")}</strong>
          <p>{variant.text}</p>
        </li>)}</ol>
        <p><strong>Otherwise</strong></p><p>{paragraph.fallback ?? "Omit this paragraph."}</p>
      </div>)}
    </>}
    <h4>Premises</h4>
    <ol>{block.premises.map(p => <li key={p.id}>
      <strong>{labels.get(p.id)}</strong><p>{p.text}</p>
      {p.quote && <blockquote>{p.quote}</blockquote>}
      <p>When withheld · {p.without}</p>
    </li>)}</ol>
    <h4>Conclusions</h4>
    <ol>{block.conclusions.map(c => <li key={c.id}><strong>{labels.get(c.id)}</strong>
      <p>{c.text}</p><p>Supported by {supportDescription(c, labels)}</p><blockquote>{c.quote}</blockquote>
    </li>)}</ol>
    <h4>Source passage</h4><blockquote>{block.passage}</blockquote>
  </section>;
}
