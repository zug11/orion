export function invalid(): never {
  throw new Error("Orion could not read this visual. Try generating it again.");
}

export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

export function list<T>(value: unknown, min: number, max: number, read: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
  return Array.from(value, read);
}

export function literal(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()) ||
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(value)) return invalid();
  return value;
}

export function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) return invalid();
  return value as T;
}

export function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return invalid();
  return value;
}
