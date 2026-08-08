import {
  ArrowLeft,
  ArrowRight,
  Command,
  Download,
  PanelRight,
  Search,
} from "../lib/icons";

interface TopbarProps {
  workspaceName: string;
  contextOpen: boolean;
  onOpenSearch: () => void;
  onExport: () => void;
  onToggleContext?: () => void;
  rightPanelLabel?: string;
  rightPanelControls?: string;
  onBack?: () => void;
  onForward?: () => void;
}

export function Topbar({
  workspaceName,
  contextOpen,
  onOpenSearch,
  onExport,
  onToggleContext,
  rightPanelLabel = "Open note details",
  rightPanelControls = "note-details-panel",
  onBack,
  onForward,
}: TopbarProps) {
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="history-controls">
        <button
          type="button"
          className="icon-button subtle"
          onClick={onBack}
          disabled={!onBack}
          aria-label="Back"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button subtle"
          onClick={onForward}
          disabled={!onForward}
          aria-label="Forward"
        >
          <ArrowRight size={16} />
        </button>
      </div>

      <div className="workspace-crumb" data-tauri-drag-region>
        <span className="workspace-pulse" data-tauri-drag-region />
        <span data-tauri-drag-region>{workspaceName}</span>
        <small data-tauri-drag-region>Local</small>
      </div>

      <button
        className="search-trigger"
        type="button"
        onClick={onOpenSearch}
      >
        <Search size={15} />
        <span>Search your atlas…</span>
        <kbd>
          <Command size={11} /> K
        </kbd>
      </button>

      <div className="topbar-actions">
        <button
          type="button"
          className="icon-button"
          onClick={onExport}
          aria-label="Share or export"
          title="Share or export"
        >
          <Download size={16} />
        </button>
        {onToggleContext && (
          <button
            type="button"
            data-right-panel-toggle
            className={contextOpen ? "icon-button active" : "icon-button"}
            onClick={onToggleContext}
            aria-label={rightPanelLabel}
            aria-controls={rightPanelControls}
            aria-expanded={contextOpen}
          >
            <PanelRight size={17} />
          </button>
        )}
      </div>
    </header>
  );
}
