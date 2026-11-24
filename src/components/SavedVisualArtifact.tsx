import { useMemo } from "react";
import { VisualArtifactView } from "./VisualArtifactView";
import { readVisualArtifactMarker, unavailableVisualArtifact } from "../lib/visualArtifactMarkdown";

export function SavedVisualArtifact({ marker }: { marker: unknown }) {
  const artifact = useMemo(() => readVisualArtifactMarker(marker), [marker]);
  return artifact ? <VisualArtifactView artifact={artifact}/> : <p>{unavailableVisualArtifact}</p>;
}
