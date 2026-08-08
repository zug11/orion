export interface TextMatch {
  from: number;
  to: number;
}

export function findTextMatches(text: string, query: string): TextMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const haystack = text.toLocaleLowerCase();
  const matches: TextMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const from = haystack.indexOf(needle, cursor);
    if (from < 0) break;
    matches.push({ from, to: from + needle.length });
    cursor = from + Math.max(needle.length, 1);
  }
  return matches;
}

export function wrapMatchIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}
