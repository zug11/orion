import { describe, expect, it } from "vitest";
import type { Note } from "../types";
import { dismissCalendarMention, restoreCalendarMention, isCalendarDismissalKey, isCalendarDismissalList, MAX_DISMISSED_CALENDAR_MENTIONS } from "./calendarDismissal";

const key = (index = 0) => `v1:0123456789abcdef:0:${index}`;
const fixture = (): Note => ({ id: "n", title: "Project", slug: "project", summary: "An authored subtitle", body: "Meet tomorrow.",
  aliases: ["Project notes"], tags: ["work"], kind: "article", status: "ready", conceptIds: ["c"], sourceIds: ["s"],
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z", headingLayout: "title", pinned: true });

describe("inferred calendar dismissal metadata", () => {
  it("changes only its metadata and preserves the original relative-date anchor", () => {
    const original = fixture(), current = { ...original, title: "Renamed project", tags: ["later"] };
    const result = dismissCalendarMention(current, original, key())!;
    expect(result).toEqual({ ...current, dismissedCalendarMentions: [key()] });
    expect(original).toEqual(fixture()); expect(current).not.toHaveProperty("dismissedCalendarMentions");
  });

  it.each(["body", "id", "createdAt"] as const)("rejects stale or replaced %s", field => {
    const captured = fixture(), current = { ...captured, [field]: "Changed" };
    expect(dismissCalendarMention(current, captured, key())).toBeNull();
  });

  it("does not duplicate a dismissal and Undo preserves later prose and other keys", () => {
    const original = fixture(), first = dismissCalendarMention(original, original, key())!;
    expect(dismissCalendarMention(first, original, key())).toBeNull();
    const later = { ...first, body: "Meet next week instead.", updatedAt: "2026-11-15T00:00:00.000Z", dismissedCalendarMentions: [key(), key(1)] };
    expect(restoreCalendarMention(later, key())).toEqual({ ...later, dismissedCalendarMentions: [key(1)] });
    expect(restoreCalendarMention(later, key(2))).toBeNull();
    expect(restoreCalendarMention(first, key())).toEqual({ ...first, dismissedCalendarMentions: [] });
  });

  it("validates bounded, unique versioned keys without accepting unsupported metadata", () => {
    expect(isCalendarDismissalKey(key())).toBe(true); expect(isCalendarDismissalList([])).toBe(true);
    for (const invalid of [null, false, {}, key(), [key(), key()], ["v2:0123456789abcdef:0:1"], ["v1:0123456789ABCDEf:0:1"], ["v1:0123456789abcdef:-1:0"], ["v1:0123456789abcdef:0:1\n"], [`v1:0123456789abcdef:0:${"1".repeat(50)}`]]) {
      expect(isCalendarDismissalList(invalid)).toBe(false);
    }
  });

  it("rejects an overfull list rather than dropping earlier dismissals", () => {
    const original = fixture(), maximum = Array.from({ length: MAX_DISMISSED_CALENDAR_MENTIONS }, (_, i) => key(i));
    const current = { ...original, dismissedCalendarMentions: maximum };
    expect(isCalendarDismissalList(maximum)).toBe(true);
    expect(isCalendarDismissalList([...maximum, key(MAX_DISMISSED_CALENDAR_MENTIONS)])).toBe(false);
    expect(dismissCalendarMention(current, original, key(MAX_DISMISSED_CALENDAR_MENTIONS))).toBeNull();
    expect(current.dismissedCalendarMentions).toHaveLength(MAX_DISMISSED_CALENDAR_MENTIONS);
  });
});
