import { useEffect, useId, useRef, useState } from "react";
import { CircleArrowUp, Download, LoaderCircle, RefreshCw, X } from "../lib/icons";
import { updateProgress } from "../lib/appUpdates";
import { useAppUpdates } from "../lib/useAppUpdates";
import "./AppUpdate.css";

type Updates = ReturnType<typeof useAppUpdates>;

function UpdateDetails({ updates }: { updates: Updates }) {
  const { status, busy, checked, check, download, install } = updates;
  const progress = updateProgress(status);
  const pending = busy || status.phase === "checking" || status.phase === "downloading" || status.phase === "installing";
  const downloading = status.phase === "downloading";
  const ready = status.phase === "ready";
  const installing = status.phase === "installing";
  const available = Boolean(status.version);
  return (
    <>
      <div className="app-update-copy">
        <strong>{installing ? "Saving and restarting…" : ready ? "Ready when you are" : downloading ? "Downloading Orion…" : available ? `Orion ${status.version} is available` : `Orion ${status.currentVersion}`}</strong>
        <p>{installing ? "Orion is saving every open window before installing the update." : ready ? "Restart Orion to finish updating. Your open notes will be saved first." : downloading ? "You can keep writing while the update downloads." : available ? "Get the latest improvements without downloading another installer." : checked && status.phase !== "error" ? "You’re up to date." : "Orion checks for new releases automatically. You choose when to install."}</p>
      </div>
      {downloading && (
        <div className="app-update-progress" role="progressbar" aria-label="Downloading Orion update" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
          <span className={progress === null ? "indeterminate" : ""} style={progress === null ? undefined : { width: `${progress}%` }} />
        </div>
      )}
      {status.error && <p className="app-update-error" role="alert">{status.error}</p>}
      <div className="app-update-actions">
        {available ? (
          <button className="button primary" type="button" disabled={pending} onClick={() => void (ready ? install() : download())}>
            {pending ? <LoaderCircle size={14} className="app-update-spinner" /> : ready ? <RefreshCw size={14} /> : <Download size={14} />}
            {installing ? "Updating…" : downloading ? progress === null ? "Downloading…" : `${progress}% downloaded` : ready ? status.error ? "Try restart again" : "Restart and update" : status.phase === "error" ? "Try download again" : "Download update"}
          </button>
        ) : (
          <button className="button ghost" type="button" disabled={pending} onClick={() => void check()}>
            {pending && <LoaderCircle size={14} className="app-update-spinner" />}
            {pending ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
    </>
  );
}

export function AppUpdateButton() {
  const updates = useAppUpdates();
  const { status } = updates;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const visible = status.supported && Boolean(status.version);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);
  if (!visible) return null;
  const inProgress = status.phase === "downloading" || status.phase === "installing";
  const label = status.phase === "ready" ? "Restart to update Orion" : inProgress ? "Orion update progress" : "Update Orion";
  return (
    <div className="app-update" ref={root} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
      <button ref={trigger} className="app-update-trigger" type="button" aria-label={label} title={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        {inProgress ? <LoaderCircle size={16} className="app-update-spinner" /> : <CircleArrowUp size={17} />}
        <span>Update</span>
      </button>
      {open && (
        <div id={id} className="app-update-popover" role="region" aria-label="Orion update">
          <button type="button" className="icon-button subtle app-update-close" aria-label="Close update details" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={14} /></button>
          <UpdateDetails updates={updates} />
        </div>
      )}
    </div>
  );
}

export function AppUpdateSettingsLink({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  const { status } = useAppUpdates();
  if (!status.supported) return null;
  return <a href="#updates" className={active ? "active" : ""} onClick={onSelect}><CircleArrowUp size={15} /> Updates</a>;
}

export function AppUpdateSettings() {
  const updates = useAppUpdates();
  if (!updates.status.supported) return null;
  return (
    <section className="settings-section" id="updates">
      <div className="settings-section-title">
        <span className="settings-icon blue"><CircleArrowUp size={18} /></span>
        <span><h2>Updates</h2><p>The latest Orion, when you’re ready.</p></span>
      </div>
      <div className="setting-card app-update-settings"><UpdateDetails updates={updates} /></div>
    </section>
  );
}
