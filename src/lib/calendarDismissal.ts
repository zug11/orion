import type { Note } from "../types";

export const MAX_DISMISSED_CALENDAR_MENTIONS = 5_000;
const DISMISSAL_KEY = /^v1:[a-f0-9]{16}:\d+:\d+$/;
export type DismissCalendarMention = (capturedNote: Note, key: string) => boolean;

export function isCalendarDismissalKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && DISMISSAL_KEY.exec(value)?.[0] === value;
}

export function isCalendarDismissalList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_DISMISSED_CALENDAR_MENTIONS &&
    value.every(isCalendarDismissalKey) && new Set(value).size === value.length;
}

/** Hide one inferred occurrence without changing authored text or its date anchor. */
export function dismissCalendarMention(current: Note, captured: Note, key: string): Note | null {
  if (current.id !== captured.id || current.createdAt !== captured.createdAt || current.body !== captured.body ||
      !isCalendarDismissalKey(key)) return null;
  const dismissed = current.dismissedCalendarMentions ?? [];
  if (!isCalendarDismissalList(dismissed) || dismissed.length >= MAX_DISMISSED_CALENDAR_MENTIONS || dismissed.includes(key)) return null;
  return { ...current, dismissedCalendarMentions: [...dismissed, key] };
}

/** Undo removes only its own key, preserving later prose and independent dismissals. */
export function restoreCalendarMention(current: Note, key: string): Note | null {
  const dismissed = current.dismissedCalendarMentions ?? [];
  if (!isCalendarDismissalKey(key) || !isCalendarDismissalList(dismissed) || !dismissed.includes(key)) return null;
  return { ...current, dismissedCalendarMentions: dismissed.filter(value => value !== key) };
}
