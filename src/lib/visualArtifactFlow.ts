export interface ArtifactFlow {
  source: string;
  destinations: number[];
  /** Maximum combined quantity over the offered settings, in the outputs' common unit. */
  capacity: number;
}

export function parseArtifactFlow(value: unknown, outputs: readonly {unit: string}[]): ArtifactFlow {
  const invalid = () => { throw new Error("A quantity flow needs a source, a positive capacity and distinct outputs measured in the same unit."); };
  if (!value || Array.isArray(value) || typeof value !== "object") return invalid();
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(key => !["source", "destinations", "capacity"].includes(key))
      || typeof obj.source !== "string" || !obj.source.trim() || obj.source.length > 100
      || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(obj.source)
      || typeof obj.capacity !== "number" || !Number.isFinite(obj.capacity) || obj.capacity <= 0 || obj.capacity > 1e9
      || !Array.isArray(obj.destinations) || obj.destinations.length < 2 || obj.destinations.length > 6) return invalid();
  const destinations: number[] = [];
  for (const index of obj.destinations) {
    if (!Number.isInteger(index) || index < 0 || index >= outputs.length || destinations.includes(index)
        || (destinations.length && outputs[index].unit !== outputs[destinations[0]].unit)) return invalid();
    destinations.push(index);
  }
  return { source: obj.source, capacity: obj.capacity, destinations };
}

export function withinFlowCapacity(amounts: readonly (number | null)[], capacity: number): boolean {
  return amounts.every(value => value !== null && Number.isFinite(value) && value >= 0)
    && amounts.reduce<number>((sum, value) => sum + (value ?? 0), 0) <= capacity * (1 + 1e-12);
}
