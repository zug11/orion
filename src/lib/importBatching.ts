import {
  MAX_BATCH_SOURCE_READINGS,
  MAX_BATCH_SOURCE_UTF8_BYTES,
  minimumSourceReadingCount,
} from "./knowledgeOrchestration/context";

export interface ImportBatchBounds {
  maxUtf8Bytes: number;
  maxSources: number;
}

export const DEFAULT_IMPORT_BATCH_BOUNDS: ImportBatchBounds = {
  maxUtf8Bytes: MAX_BATCH_SOURCE_UTF8_BYTES,
  maxSources: MAX_BATCH_SOURCE_READINGS,
};

/**
 * Partitions an ordered source selection into batches that each fit one
 * bounded knowledge synthesis. The packing is deterministic and preserves the
 * user's order: sources join the current batch until the next source would
 * exceed the byte, source-count, or canonical reading bound, then a new batch
 * begins. A single source that alone exceeds these bounds is passed through
 * as its own batch so the run surfaces the existing oversized-source
 * explanation instead of silently dropping material.
 */
export function partitionImportSourcesForSynthesis<T>(
  sources: readonly T[],
  sourceText: (source: T) => string,
  bounds: ImportBatchBounds = DEFAULT_IMPORT_BATCH_BOUNDS,
): T[][] {
  const maxUtf8Bytes = Math.max(1, Math.floor(bounds.maxUtf8Bytes));
  const maxSources = Math.max(1, Math.floor(bounds.maxSources));
  const encoder = new TextEncoder();
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  let batchReadings = 0;

  for (const source of sources) {
    const text = sourceText(source);
    const sourceBytes = encoder.encode(text).byteLength;
    const sourceReadings = sourceBytes > maxUtf8Bytes
      ? undefined
      : minimumSourceReadingCount(text);
    if (sourceReadings === undefined) {
      // Oversized singleton passthrough: it can never share a batch, and it
      // must still reach the run so the existing bounded-synthesis error
      // explains it to the user.
      if (batch.length > 0) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
        batchReadings = 0;
      }
      batches.push([source]);
      continue;
    }
    if (
      batch.length >= maxSources ||
      batchBytes + sourceBytes > maxUtf8Bytes ||
      batchReadings + sourceReadings > MAX_BATCH_SOURCE_READINGS
    ) {
      if (batch.length > 0) {
        batches.push(batch);
      }
      batch = [];
      batchBytes = 0;
      batchReadings = 0;
    }
    batch.push(source);
    batchBytes += sourceBytes;
    batchReadings += sourceReadings;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}
