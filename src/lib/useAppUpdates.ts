import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { createAppUpdateStore, type AppUpdateStatus } from "./appUpdates";

const store = createAppUpdateStore({
  isNative: isTauri,
  invoke: async (command) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<AppUpdateStatus>(command);
  },
  listen: async (callback) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AppUpdateStatus>("orion:update-status", (event) => callback(event.payload));
  },
  onFocus: (callback) => {
    window.addEventListener("focus", callback);
    return () => window.removeEventListener("focus", callback);
  },
});

export function useAppUpdates() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...snapshot, check: store.check, download: store.download, install: store.install };
}
