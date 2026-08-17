import {
  MAX_BATCH_SOURCE_READINGS,
  MAX_BATCH_SOURCE_UTF8_BYTES,
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
 * exceed the batch byte or count bound, then a new batch begins. A single
 * source that alone exceeds the byte bound is passed through as its own
 * batch so the run surfaces the existing oversized-source explanation
 * instead of silently dropping material.
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

  for (const source of sources) {
    const sourceBytes = encoder.encode(sourceText(source)).byteLength;
    if (sourceBytes > maxUtf8Bytes) {
      // Oversized singleton passthrough: it can never share a batch, and it
      // must still reach the run so the existing bounded-synthesis error
      // explains it to the user.
      if (batch.length > 0) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batches.push([source]);
      continue;
    }
    if (
      batch.length >= maxSources ||
      batchBytes + sourceBytes > maxUtf8Bytes
    ) {
      if (batch.length > 0) {
        batches.push(batch);
      }
      batch = [];
      batchBytes = 0;
    }
    batch.push(source);
    batchBytes += sourceBytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}
