import { useState } from "react";
import "./AssistantConnections.css";
import type { AssistantAccess, WorkspaceInfo } from "../types";
import type { AssistantJob } from "../lib/assistant/types";
import { defaultSettings } from "../data/defaults";

interface Props {
  access?: AssistantAccess;
  spaces: WorkspaceInfo[];
  jobs: AssistantJob[];
  desktop: boolean;
  onChange: (access: AssistantAccess) => void;
  onCancel?: (job: AssistantJob) => Promise<void>;
}

const operationNames: Record<AssistantJob["operation"], string> = {
  context: "Context", research: "Research", import: "Import", reprocess: "Reprocess sources",
  generate: "Generate", develop_concept: "Develop concept", enrich_knowledge: "Enrich knowledge", refresh_overview: "Refresh overview",
};

export function AssistantConnections({ access = defaultSettings.assistantAccess, spaces, jobs, desktop, onChange, onCancel }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const change = (patch: Partial<AssistantAccess>) => onChange({ ...access, ...patch });
  return <div className="setting-card assistant-connections">
    <div className="setting-card-header">
      <span><strong>Orion workflows</strong><small>Let Codex and Claude Desktop use Orion’s context, import, and generation tools while Orion is open.</small></span>
    </div>
    <label className="assistant-permission">
      <input type="checkbox" checked={access.enabled} disabled={!desktop} onChange={(event) => change({ enabled: event.target.checked })} />
      <span><strong>Enable desktop workflows</strong><small>Context and results are shared with the connected assistant under its account settings.</small></span>
    </label>
    <fieldset disabled={!desktop || !access.enabled}>
      <legend>Allowed workflows</legend>
      <label className="assistant-permission">
        <input type="checkbox" checked={access.allowAI} onChange={(event) => change({ allowAI: event.target.checked })} />
        <span><strong>Use Orion AI</strong><small>Use the model and API account configured in Orion. Provider usage is billed to that account. The existing-note context preference still applies.</small></span>
      </label>
      <label className="assistant-permission">
        <input type="checkbox" checked={access.allowWrites} onChange={(event) => change({ allowWrites: event.target.checked })} />
        <span><strong>Import and save workflow results</strong><small>Import supplied local files or public URLs, reprocess sources, and create or develop notes. Source extraction stays available without AI.</small></span>
      </label>
      <div className="assistant-space-heading">Allowed Spaces</div>
      <div className="assistant-spaces" aria-label="Spaces allowed for desktop workflows">
        {spaces.map((space) => <label key={space.id}>
          <input type="checkbox" checked={access.spaceIds.includes(space.id)} onChange={(event) => change({ spaceIds: event.target.checked ? [...new Set([...access.spaceIds, space.id])] : access.spaceIds.filter((id) => id !== space.id) })} />
          <span>{space.name}</span>
        </label>)}
      </div>
      {spaces.length === 0 ? <p className="setting-message">Create a Space to enable its workflows.</p> : null}
      {access.enabled && access.spaceIds.length === 0 && spaces.length > 0 ? <p className="setting-message">Select at least one Space before starting a workflow.</p> : null}
    </fieldset>
    <p className="setting-message">These controls apply to the new workflows. The installed connectors’ existing search and direct note-editing tools keep their current access.</p>
    {jobs.length > 0 ? <div className="assistant-activity" aria-label="Recent desktop workflows">
      <strong>Recent activity</strong>
      {jobs.map((job) => <div className="assistant-job" key={job.id}>
        <span><strong>{operationNames[job.operation]} · {spaces.find((space) => space.id === job.spaceId)?.name ?? "Removed Space"}</strong>
          <small>{job.state === "succeeded" ? "Completed" : job.state === "failed" || job.state === "cancelled" ? job.error ?? job.state : job.stage}</small></span>
        {onCancel && (job.state === "queued" || job.state === "running") ? <button type="button" className="button compact" disabled={cancelling === job.id} onClick={async () => {
          setCancelling(job.id); setError(null);
          try { await onCancel(job); } catch (error) { setError(String(error)); } finally { setCancelling(null); }
        }}>Cancel</button> : null}
      </div>)}
    </div> : null}
    {error ? <p className="setting-message" role="alert">{error}</p> : null}
  </div>;
}
