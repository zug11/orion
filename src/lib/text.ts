/** Truncate by Unicode code points without cutting a UTF-16 surrogate pair. */
export function truncateUnicode(value: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0 || !value) return "";
  let end = 0;
  let count = 0;
  for (const character of value) {
    if (count >= maxCodePoints) break;
    end += character.length;
    count += 1;
  }
  return end >= value.length ? value : value.slice(0, end);
}
