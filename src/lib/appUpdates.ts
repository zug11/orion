export type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";

export interface AppUpdateStatus {
  supported: boolean;
  currentVersion: string;
  phase: AppUpdatePhase;
  version?: string | null;
  notes?: string | null;
  downloaded?: number;
  total?: number | null;
  error?: string | null;
  installed?: boolean;
}

type UpdateCommand = "get_app_update_status" | "check_app_update" | "download_app_update" | "install_app_update";

export interface AppUpdateHost {
  isNative: () => boolean;
  invoke: (command: UpdateCommand) => Promise<AppUpdateStatus>;
  listen: (callback: (status: AppUpdateStatus) => void) => Promise<() => void>;
  onFocus: (callback: () => void) => () => void;
}

export interface AppUpdateSnapshot {
  status: AppUpdateStatus;
  busy: boolean;
  checked: boolean;
}

export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export const UPDATE_STARTUP_DELAY = 12_000;

/** One lightweight store per window; update progress never rerenders App or the editor. */
export function createAppUpdateStore(host: AppUpdateHost) {
  let snapshot: AppUpdateSnapshot = {
    status: { supported: false, currentVersion: "", phase: "idle" },
    busy: false,
    checked: false,
  };
  const subscribers = new Set<() => void>();
  let generation = 0;
  let eventRevision = 0;
  let lastCheck = 0;
  let releaseListener: (() => void) | undefined;
  let releaseFocus: (() => void) | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  function publish(next: AppUpdateSnapshot) {
    snapshot = next;
    subscribers.forEach((subscriber) => subscriber());
  }

  async function perform(command: Exclude<UpdateCommand, "get_app_update_status">) {
    if (!snapshot.status.supported || snapshot.busy) return;
    const revision = eventRevision;
    const lifetime = generation;
    if (command === "check_app_update") lastCheck = Date.now();
    publish({ ...snapshot, busy: true });
    try {
      const status = await host.invoke(command);
      if (lifetime !== generation) return;
      // A newer broadcast wins over an older command response from another window.
      publish({
        ...snapshot,
        status: revision === eventRevision ? status : snapshot.status,
        busy: false,
        checked: snapshot.checked || command === "check_app_update",
      });
    } catch (error) {
      if (lifetime !== generation) return;
      publish({
        ...snapshot,
        busy: false,
        status: { ...snapshot.status, phase: "error", error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function checkInBackground() {
    if (snapshot.status.phase !== "idle" && !(snapshot.status.phase === "error" && !snapshot.status.version)) return;
    void perform("check_app_update");
  }

  async function start() {
    if (!host.isNative()) return;
    const lifetime = ++generation;
    try {
      const stop = await host.listen((status) => {
        if (lifetime !== generation) return;
        eventRevision += 1;
        publish({ ...snapshot, status });
      });
      if (lifetime !== generation) { stop(); return; }
      releaseListener = stop;
      const revision = eventRevision;
      const status = await host.invoke("get_app_update_status");
      if (lifetime !== generation) return;
      if (revision === eventRevision) publish({ ...snapshot, status, busy: false });
      if (!snapshot.status.supported) return;
      lastCheck = Date.now();
      startup = setTimeout(checkInBackground, UPDATE_STARTUP_DELAY);
      interval = setInterval(checkInBackground, UPDATE_CHECK_INTERVAL);
      releaseFocus = host.onFocus(() => {
        if (Date.now() - lastCheck >= UPDATE_CHECK_INTERVAL) checkInBackground();
      });
    } catch {
      // Unsupported/older native hosts and browser previews have no updater UI.
      // A release host's later check/download failures remain visible in Settings.
    }
  }

  function stop() {
    generation += 1;
    releaseListener?.();
    releaseListener = undefined;
    releaseFocus?.();
    releaseFocus = undefined;
    clearTimeout(startup);
    clearInterval(interval);
    snapshot = { ...snapshot, busy: false };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (callback: () => void) => {
      subscribers.add(callback);
      if (subscribers.size === 1) void start();
      return () => {
        subscribers.delete(callback);
        if (subscribers.size === 0) stop();
      };
    },
    check: () => perform("check_app_update"),
    download: () => perform("download_app_update"),
    install: () => perform("install_app_update"),
  };
}

export function updateProgress(status: AppUpdateStatus): number | null {
  if (!status.total || !Number.isFinite(status.total) || status.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor(((status.downloaded ?? 0) / status.total) * 100)));
}
