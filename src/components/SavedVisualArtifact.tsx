import { ArtifactPartChatContext } from "./ArtifactPartChatContext";
import { useContext, useMemo } from "react";
import { VisualArtifactView } from "./VisualArtifactView";
import { readVisualArtifactMarker, unavailableVisualArtifact } from "../lib/visualArtifactMarkdown";

export function SavedVisualArtifact({ marker, onAddTasks }: { marker: unknown; onAddTasks?: (tasks: string[]) => boolean }) {
  const onAskPart = useContext(ArtifactPartChatContext);
  const artifact = useMemo(() => readVisualArtifactMarker(marker), [marker]);
  return artifact ? <VisualArtifactView artifact={artifact} onAddTasks={onAddTasks} onAskPart={onAskPart}/> : <p>{unavailableVisualArtifact}</p>;
}
