import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeExternalLink } from "./externalLinks";

/** Explicit editor navigation; normal anchor clicks retain the writing caret. */
export async function openEditorExternalLink(value: string): Promise<void> {
  const url = normalizeExternalLink(value);
  if (!url) throw new Error("Enter a valid http or https web address.");
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
