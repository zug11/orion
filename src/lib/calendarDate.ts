/** All-day dates deliberately have no UTC conversion or time-zone offset. */
export function validCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function localDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}
export function dateLabel(value: string, short = false): string {
  return localDate(value).toLocaleDateString('en-AU', { day: 'numeric', month: short ? 'short' : 'long', ...(short ? {} : { year: 'numeric' as const }) });
}
export function shiftDate(value: string, days: number): string {
  const date = localDate(value); date.setDate(date.getDate() + days); return dateKey(date);
}
export function shiftMonth(value: string, months: number): string {
  const date = localDate(value), day = date.getDate(); date.setDate(1); date.setMonth(date.getMonth() + months);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate(); date.setDate(Math.min(day, last)); return dateKey(date);
}
export function calendarDateFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('orion-date://')) return null;
  const date = url.slice('orion-date://'.length); return validCalendarDate(date) ? date : null;
}
