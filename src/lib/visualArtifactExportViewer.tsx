import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { VisualArtifactView } from "../components/VisualArtifactView";
import { readVisualArtifactMarker } from "./visualArtifactMarkdown";
import type { VisualArtifact } from "./visualArtifacts";

function ExportViewer({ artifact, host }: { artifact: VisualArtifact; host: HTMLElement }) {
  // Keep the readable version visible until React has actually drawn the controls.
  useLayoutEffect(() => {
    host.setAttribute("data-orion-artifact-ready", "");
    return () => host.removeAttribute("data-orion-artifact-ready");
  }, [host]);
  return <VisualArtifactView artifact={artifact} />;
}

for (const host of document.querySelectorAll<HTMLElement>("[data-orion-artifact-viewer]")) {
  const artifact = readVisualArtifactMarker(host.dataset.orionArtifactViewer);
  if (artifact) createRoot(host).render(<ExportViewer artifact={artifact} host={host} />);
}
