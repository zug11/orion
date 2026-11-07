import { isTauri } from "@tauri-apps/api/core";

export function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
}

export function isWindowsDesktop(): boolean {
  return isWindows() && isTauri();
}

export function primaryShortcut(key: string): string {
  return isWindows() ? `Ctrl+${key}` : `⌘${key}`;
}

export function desktopCredentialStore(): string {
  return isWindows() ? "Windows Credential Manager" : "macOS Keychain";
}
