import type { ChatResult, Note, Settings } from "../types";
import { asksForIllustration, generatePassageIllustration, generateVisualArtifact } from "./visualArtifactGeneration";
import type { VisualArtifact } from "./visualArtifacts";
import { chatEditableBody } from "./chatEdits";
import { stripMarkdownComments } from "./markdown";
import { requestedTaskView, workingTaskText } from "./taskWorkingView";
import { visualArtifactMarker } from "./visualArtifactMarkdown";
import type { ChatVisualHeading } from "./chatVisualStream";

export type ChatVisualPreview = { answer: ChatResult; artifact?: VisualArtifact; heading?: ChatVisualHeading; model?: string; progress?: string };

function bounded(value: string, size: number): string {
  const clipped = value.slice(0, size);
  return /[\uD800-\uDBFF]$/u.test(clipped) ? clipped.slice(0, -1) : clipped;
}

export async function finishChatVisual(
  result: ChatResult, prompt: string, selected: string | undefined, requested: boolean,
  settings: Settings, signal: AbortSignal, onPreview: (preview: ChatVisualPreview) => void, previousReply?: string, attachedNote?: Note,
): Promise<ChatResult> {
  const { reply, visualFormat: format } = result;
  const answer = result;
  const command = prompt.trim().replace(/^(?:(?:please|can you|could you|would you)\s+)*/iu, "");
  const explicit = /^(?:draw|sketch|illustrate|visuali[sz]e|diagram)\b/iu.test(command)
    || /^(?:show|make|create|generate|build|give)\s+(?:me\s+)?(?:an?\s+)?(?:interactive\s+)?(?:artifact|visual|diagram|svg|illustration|picture|drawing|calculator|timeline|quiz|chart|cycle|linked views|argument explorer|scale zoom|deep time)\b/iu.test(command);
  if (result.editProposal || (!requested && !format && !explicit) || !reply.trim()) return answer;
  onPreview({ answer });
  // Preserve verbatim selections/citations as source material. An answer being
  // drawn for a follow-up is explicitly identified as Chat-authored text.
  const passages = result.evidence?.map(item => item.text.trim()).filter(Boolean) ?? [];
  const previous = /\b(?:your|last|previous|that|this|above)\s+(?:answer|reply|explanation|response)\b/iu.test(prompt) ? previousReply : undefined;
  // A focused note can accompany an unrelated question. Use its whole body
  // only when the request identifies that note as the subject of the visual.
  const wantsNote = /\b(?:this|attached|current|open|whole|entire)\s+(?:note|document)\b/iu.test(prompt);
  let noteBody: string | undefined;
  if (selected === undefined && attachedNote && !previous && wantsNote && (requested || explicit)) {
    const body = chatEditableBody(attachedNote.body).body;
    noteBody = stripMarkdownComments(requestedTaskView(prompt) === "history" ? body : workingTaskText(body)).trim();
  }
  const source = selected?.trim() ?? noteBody ?? (passages.length ? passages.join("\n\n") + "\n\nUser request\n" + prompt
    : previous ? "Previous Chat reply\n" + previous
    : "User request\n" + prompt + "\n\nChat reply\n" + reply.replace(/\[[^\]]*\]\(#orion-evidence-e\d+\)/gu, ""));
  const guidance = bounded(prompt, 800);
  const draw = explicit && asksForIllustration(command);
  const conversational = selected === undefined && noteBody === undefined && !passages.length;
  const identifySource = <T extends { summary?: string }>(item: T): T => {
    if (!conversational) return item;
    const credit = previous ? "Based on the previous Chat reply." : "Based on your request and the Chat reply.";
    return { ...item, summary: bounded([credit, item.summary].filter(Boolean).join(" "), 600) };
  };
  let preview: ChatVisualPreview = { answer };
  const publish = (change: Partial<ChatVisualPreview>) => {
    preview = { ...preview, ...change };
    onPreview(preview);
  };
  const onModelSelected = (model: string) => publish({ model });
  const onSourceProgress = (progress: string) => publish({ progress });
  const show = (artifact: VisualArtifact) => publish({ artifact: identifySource(artifact) });
  const showHeading = (heading: ChatVisualHeading) => publish({ heading: identifySource(heading) });
  try {
    const visual = draw
      ? await generatePassageIllustration(source, guidance, settings, signal, { onPreview: show, onHeading: showHeading, onModelSelected, onSourceProgress })
      : await generateVisualArtifact(source, format ?? "auto", guidance, settings, signal, show, showHeading, onModelSelected, onSourceProgress);
    return { ...answer, visualArtifact: visualArtifactMarker(identifySource(visual)) };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { ...answer, visualError: bounded(error instanceof Error ? error.message : "The visual could not be generated.", 400) };
  }
}
