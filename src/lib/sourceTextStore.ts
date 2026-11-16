import type { OrionVault } from "../types";

/**
 * Preserved source text lives beside the vault, not inside it.
 *
 * Source text is immutable once imported and can be megabytes per source, while
 * `vault.json` is re-read, merged and rewritten on every autosave. The desktop
 * host therefore keeps each text in a content-addressed file, the same way note
 * images are kept, and a persisted source record carries
 * `textRef: { sha256, bytes, chars }` instead of `text`.
 *
 * This module is the only place that knows about that format. Everything else
 * in the renderer keeps working with ordinary `Source.text` strings:
 * `hydrate` turns a loaded vault into the in-memory model and `externalize`
 * turns it back just before it crosses to the native host. Text the window
 * already holds is never sent or requested again.
 */

/** The `textRef` value stored on a source record in place of its text. */
export interface SourceTextRef {
  sha256: string;
  bytes: number;
  chars: number;
}

export interface SourceTextHost {
  /** Stores each text and returns its reference, in order. */
  save(texts: string[]): Promise<SourceTextRef[]>;
  /** Returns the verified text for each reference, in order. */
  load(references: SourceTextRef[]): Promise<string[]>;
}

/** Native error prefix: a vault referred to text that is not on disk. */
export const SOURCE_TEXT_MISSING = "ORION_SOURCE_TEXT_MISSING";

const INLINE_VAULT_SCHEMA = 2;
const EXTERNAL_TEXT_VAULT_SCHEMA = 3;
// Bounds for one host request, well inside the native 96 MiB limit. A UTF-16
// unit is at most three UTF-8 bytes.
const MAX_SAVE_UNITS = 8 * 1024 * 1024;
const MAX_LOAD_BYTES = 24 * 1024 * 1024;
const MAX_REQUEST_TEXTS = 1024;
// A text unused for this many passes (saves or loads) is forgotten, so deleted
// sources do not stay in memory for the rest of the session.
const RETAINED_PASSES = 16;

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function isSourceTextRef(value: unknown): value is SourceTextRef {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    isCount(value.bytes) &&
    isCount(value.chars) &&
    value.chars <= value.bytes &&
    value.bytes <= value.chars * 4
  );
}

function batches<T>(items: readonly T[], weight: (item: T) => number, limit: number): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  let total = 0;
  for (const item of items) {
    const size = weight(item);
    if (current.length && (total + size > limit || current.length >= MAX_REQUEST_TEXTS)) {
      result.push(current);
      current = [];
      total = 0;
    }
    current.push(item);
    total += size;
  }
  if (current.length) result.push(current);
  return result;
}

export interface SourceTextStore {
  /** In-memory vault → the form written to disk. Stores any text not stored yet. */
  externalize(vault: OrionVault): Promise<unknown>;
  /** A value read from disk → the in-memory form, loading only unknown text. */
  hydrate(value: unknown): Promise<unknown>;
  /** Forget which texts are stored, so the next save sends them all again. */
  forget(): void;
}

export function createSourceTextStore(host: SourceTextHost): SourceTextStore {
  // Keyed by the text itself: identical text in two sources is stored once, and
  // a lookup for text already held is a pointer comparison.
  const stored = new Map<string, { reference: SourceTextRef; used: number }>();
  const texts = new Map<string, string>();
  let pass = 0;
  // Saves are serialized: a second save waits for the first to store its text
  // instead of sending the same megabytes again.
  let saving: Promise<unknown> = Promise.resolve();

  function remember(text: string, reference: SourceTextRef, used: number) {
    stored.set(text, { reference, used });
    texts.set(reference.sha256, text);
  }

  function sweep(current: number) {
    for (const [text, entry] of stored) {
      if (entry.used > current - RETAINED_PASSES) continue;
      stored.delete(text);
      if (texts.get(entry.reference.sha256) === text) texts.delete(entry.reference.sha256);
    }
  }

  async function externalize(vault: OrionVault): Promise<unknown> {
      const current = ++pass;
      const unknown = new Set<string>();
      for (const space of vault.spaces) {
        for (const source of space.sources) {
          if (!source.text) continue;
          const known = stored.get(source.text);
          if (known) known.used = current;
          else unknown.add(source.text);
        }
      }
      for (const batch of batches([...unknown], (text) => text.length, MAX_SAVE_UNITS)) {
        const references = await host.save(batch);
        if (!Array.isArray(references) || references.length !== batch.length || !references.every(isSourceTextRef)) {
          throw new Error("Orion could not confirm that the source text was stored. Nothing was saved.");
        }
        batch.forEach((text, index) => remember(text, references[index], current));
      }
      let external = false;
      const spaces = vault.spaces.map((space) => {
        if (!space.sources.some((source) => source.text)) return space;
        external = true;
        return {
          ...space,
          sources: space.sources.map((source) => {
            if (!source.text) return source;
            const { text, ...record } = source;
            // Present unless a concurrent pass swept it; then fail the save
            // rather than write a record with neither text nor reference.
            const entry = stored.get(text);
            if (!entry) throw new Error("Orion could not confirm that the source text was stored. Nothing was saved.");
            return { ...record, textRef: entry.reference };
          }),
        };
      });
      sweep(current);
      return external ? { ...vault, schemaVersion: EXTERNAL_TEXT_VAULT_SCHEMA, spaces } : vault;
  }

  return {
    externalize(vault) {
      const run = saving.then(() => externalize(vault), () => externalize(vault));
      saving = run.catch(() => undefined);
      return run;
    },

    async hydrate(value) {
      // Only the external-text schema needs work; anything else goes to the
      // ordinary validator unchanged.
      if (!isRecord(value) || value.schemaVersion !== EXTERNAL_TEXT_VAULT_SCHEMA || !Array.isArray(value.spaces)) {
        return value;
      }
      const current = ++pass;
      const targets: { source: RecordValue; reference: SourceTextRef }[] = [];
      const wanted = new Map<string, SourceTextRef>();
      for (const space of value.spaces) {
        if (!isRecord(space) || !Array.isArray(space.sources)) continue;
        for (const source of space.sources) {
          if (!isRecord(source) || source.textRef === undefined) continue;
          const reference = source.textRef;
          if (source.text !== undefined || !isSourceTextRef(reference)) {
            throw new Error("The local Orion vault has an invalid source text reference.");
          }
          targets.push({ source, reference });
          const known = texts.get(reference.sha256);
          if (known === undefined) wanted.set(reference.sha256, reference);
        }
      }
      for (const batch of batches([...wanted.values()], (reference) => reference.bytes, MAX_LOAD_BYTES)) {
        const loaded = await host.load(batch);
        if (!Array.isArray(loaded) || loaded.length !== batch.length || !loaded.every((text) => typeof text === "string" && text.length > 0)) {
          throw new Error("Orion could not read its preserved source text.");
        }
        batch.forEach((reference, index) => remember(loaded[index], reference, current));
      }
      for (const { source, reference } of targets) {
        const text = texts.get(reference.sha256);
        if (text === undefined) throw new Error("Orion could not read its preserved source text.");
        // The value was just deserialized for this call, so it is ours to fill.
        source.text = text;
        delete source.textRef;
        remember(text, reference, current);
      }
      sweep(current);
      return { ...value, schemaVersion: INLINE_VAULT_SCHEMA };
    },

    forget() {
      stored.clear();
      texts.clear();
    },
  };
}
