const MAX_EXTERNAL_LINK_LENGTH = 2_048;
const DOMAIN_START = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?::\d{1,5})?(?:[/?#]|$)/u;
const SCHEME_START = /^[a-z][a-z\d+.-]*:/i;

/** Distinguishes a pasted address from ordinary note-search text. */
export function isPotentialExternalLink(value: string): boolean {
  const text = value.trim();
  return SCHEME_START.test(text) || text.startsWith("//") || DOMAIN_START.test(text);
}

/** Only explicit web URLs and recognizable bare domains become external links. */
export function normalizeExternalLink(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > MAX_EXTERNAL_LINK_LENGTH || /[\u0000-\u0020\u007f\\]/.test(text)) {
    return null;
  }
  let candidate: string;
  if (/^https?:\/\//i.test(text)) {
    candidate = text;
  } else if (DOMAIN_START.test(text)) {
    candidate = `https://${text}`;
  } else {
    return null;
  }
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname || url.username || url.password) {
      return null;
    }
    return url.href.length <= MAX_EXTERNAL_LINK_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}
