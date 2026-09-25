import { createContext, memo, useContext, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppSnapshot, ChatEvidence, StudioMessage } from "../types";
import { CitedPassage } from "./CitedPassage";

interface ChatReplyProps {
  snapshot: AppSnapshot;
  message: StudioMessage;
  onOpenNote: (id: string) => void;
  onOpenSource?: (id: string) => void;
}

const CitationContext = createContext<{
  evidence: ChatEvidence[]; selectedId: string | null; panelId: string;
  select: (id: string | null, trigger: HTMLButtonElement) => void;
}>({ evidence: [], selectedId: null, panelId: "", select: () => undefined });

const ChatLink: NonNullable<Components["a"]> = ({ href, children }) => {
  const { evidence, selectedId, panelId, select } = useContext(CitationContext);
  if (href?.startsWith("#orion-evidence-")) {
    const citation = evidence.find((item) => href === `#orion-evidence-${item.id}`);
    if (!citation) return <span title="This reference is unavailable">{children}</span>;
    return <button type="button" className="chat-citation" aria-label={`Read citation: ${citation.title}`}
      aria-expanded={selectedId === citation.id} aria-controls={panelId}
      onClick={(event) => select(selectedId === citation.id ? null : citation.id, event.currentTarget)}>{children}</button>;
  }
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
};
const CHAT_COMPONENTS: Components = { a: ChatLink };

export const ChatReply = memo(function ChatReply({ snapshot, message, onOpenNote, onOpenSource }: ChatReplyProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const citationTrigger = useRef<HTMLButtonElement | null>(null);
  const evidence = message.evidence ?? [];
  const selected = evidence.find((item) => item.id === selectedId);
  const panelId = `chat-evidence-${message.id}`;
  const closeEvidence = () => {
    setSelectedId(null);
    citationTrigger.current?.focus({ preventScroll: true });
  };
  const coverage = message.coverage;
  return <>
    <div className="chat-message__body">
      <CitationContext.Provider value={{ evidence, selectedId, panelId, select: (id, trigger) => {
        citationTrigger.current = trigger;
        setSelectedId(id);
      } }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_COMPONENTS}>{message.content}</ReactMarkdown>
      </CitationContext.Provider>
    </div>
    {selected && <CitedPassage evidence={selected} notes={snapshot.notes} sources={snapshot.sources}
      panelId={panelId} savedWith="reply" onClose={closeEvidence} onOpenNote={onOpenNote} onOpenSource={onOpenSource} />}
    {coverage && (coverage.availableNotes > 0 || coverage.availableSources > 0) &&
      <p className="chat-message__coverage">Read {coverage.openedNotes} {coverage.openedNotes === 1 ? "note" : "notes"} and {coverage.openedSources} {coverage.openedSources === 1 ? "source" : "sources"}
        {coverage.limited ? " · Partial Space coverage" : ""}</p>}
  </>;
});
