import { Download } from "../lib/icons";
import "./WritingWindowHeader.css";

interface WritingWindowHeaderProps {
  title: string;
  onExport?: () => void;
}

export function WritingWindowHeader({
  title,
  onExport,
}: WritingWindowHeaderProps) {
  return (
    <header className="writing-window-header" data-tauri-drag-region="deep">
      <span className="writing-window-title" title={title} data-tauri-drag-region>
        {title}
      </span>
      <div className="writing-window-actions">
        {onExport && (
          <button
            type="button"
            className="icon-button subtle"
            onClick={onExport}
            aria-label="Share or export"
            title="Share or export"
          >
            <Download size={16} />
          </button>
        )}
      </div>
    </header>
  );
}
