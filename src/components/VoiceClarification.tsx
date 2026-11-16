import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import "./VoiceClarification.css";

export interface VoiceClarificationChoice {
  id: string;
  label: string;
  description?: string;
}

export interface VoiceClarificationAnswer {
  choiceId?: string;
  text: string;
}

export interface VoiceClarificationProps {
  /** The captured question's identity, including its revision. */
  clarificationId?: string;
  question: string;
  choices: readonly VoiceClarificationChoice[];
  busy?: boolean;
  /** Return false when submission was rejected before any async work starts. */
  onSubmit: (answer: VoiceClarificationAnswer) => boolean | void;
  onCancel: () => void;
}

/** An answer belongs to one captured clarification, never the Chat draft. */
export function VoiceClarification(props: VoiceClarificationProps) {
  const identity = props.clarificationId ?? JSON.stringify([props.question, props.choices.map(choice => choice.id)]);
  return <ClarificationForm key={identity} {...props} />;
}

function ClarificationForm({ question, choices, busy = false, onSubmit, onCancel }: VoiceClarificationProps) {
  const id = useId();
  const [choiceId, setChoiceId] = useState<string>();
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);
  const selected = choices.some(choice => choice.id === choiceId) ? choiceId : undefined;
  const disabled = busy || submitted;

  useEffect(() => {
    // A rejected/failed parent operation may re-open the same question. Keep
    // its answer for correction while permitting the explicit retry.
    if (!busy) { submittedRef.current = false; setSubmitted(false); }
  }, [busy]);

  function changed() { submittedRef.current = false; setSubmitted(false); }
  function submit(event: FormEvent) {
    event.preventDefault();
    const reply = text.trim();
    if (busy || submittedRef.current || (!selected && !reply)) return;
    submittedRef.current = true;
    setSubmitted(true);
    if (onSubmit({ ...(selected ? { choiceId: selected } : {}), text: reply }) === false) changed();
  }

  return <form className="voice-clarification" aria-labelledby={`${id}-question`} aria-busy={busy} onSubmit={submit}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      event.preventDefault(); event.stopPropagation(); onCancel();
    }}>
    <p className="voice-clarification__question" id={`${id}-question`}>{question}</p>
    <div className="voice-clarification__body">
    {!!choices.length && <fieldset className="voice-clarification__choices" disabled={busy} aria-labelledby={`${id}-question`}>
      {choices.map((choice, index) => <label className={`voice-clarification__choice${selected === choice.id ? " is-selected" : ""}`} key={choice.id}>
        <input type="radio" name={`${id}-choice`} value={choice.id} checked={selected === choice.id}
          aria-labelledby={`${id}-choice-${index}`} aria-describedby={choice.description ? `${id}-detail-${index}` : undefined}
          onChange={() => { changed(); setChoiceId(choice.id); }} />
        <span><span id={`${id}-choice-${index}`} className="voice-clarification__choice-label">{choice.label}</span>
          {choice.description && <span id={`${id}-detail-${index}`} className="voice-clarification__choice-detail">{choice.description}</span>}
        </span>
      </label>)}
    </fieldset>}
    <label className="voice-clarification__reply" htmlFor={`${id}-reply`}>
      <span>{choices.length ? "Your reply (optional)" : "Your reply"}</span>
      <textarea id={`${id}-reply`} value={text} disabled={busy} rows={2} maxLength={4000}
        placeholder={choices.length ? "Add details or write a different answer…" : "Write your answer…"}
        onChange={event => { changed(); setText(event.target.value); }} />
    </label>
    </div>
    <div className="voice-clarification__actions">
      <button type="button" className="voice-clarification__cancel" onClick={onCancel}>Cancel</button>
      <button type="submit" className="voice-clarification__continue" disabled={disabled || (!selected && !text.trim())}>
        {disabled ? "Continuing…" : "Continue"}
      </button>
    </div>
  </form>;
}
