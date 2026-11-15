import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyVault } from "../data/defaults";
import type { OrionVault, Source } from "../types";
import { createSourceTextStore, isSourceTextRef, SOURCE_TEXT_MISSING, type SourceTextHost, type SourceTextRef } from "./sourceTextStore";

const NOW = "2026-11-01T00:00:00.000Z";

function source(id: string, text: string): Source {
  return { id, title: `Source ${id}`, kind: "text", importedAt: NOW, text, noteIds: [] };
}

function vaultWith(...sources: Source[]): OrionVault {
  const vault = createEmptyVault("Atlas", NOW);
  vault.spaces[0].sources = sources;
  return vault;
}

/** An in-memory stand-in for the native content-addressed store. */
function fakeHost() {
  const files = new Map<string, string>();
  let next = 0;
  const hashes = new Map<string, string>();
  const reference = (text: string): SourceTextRef => {
    let sha256 = hashes.get(text);
    if (!sha256) {
      sha256 = (++next).toString(16).padStart(64, "0");
      hashes.set(text, sha256);
    }
    return { sha256, bytes: new TextEncoder().encode(text).length, chars: [...text].length };
  };
  const host = {
    save: vi.fn(async (texts: string[]) => texts.map((text) => {
      const stored = reference(text);
      files.set(stored.sha256, text);
      return stored;
    })),
    load: vi.fn(async (references: SourceTextRef[]) => references.map((item) => {
      const text = files.get(item.sha256);
      if (text === undefined) throw new Error(`${SOURCE_TEXT_MISSING}: missing`);
      return text;
    })),
  } satisfies SourceTextHost;
  return { host, files };
}

/** What crosses the IPC boundary and comes back from disk. */
const throughDisk = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("source text store", () => {
  it("writes references instead of text and marks the external-text schema", async () => {
    const { host } = fakeHost();
    const store = createSourceTextStore(host);
    const vault = vaultWith(source("a", "Alpha é😀 text"), source("b", ""), source("c", "Alpha é😀 text"));

    const disk = await store.externalize(vault) as { schemaVersion: number; spaces: { sources: Record<string, unknown>[] }[] };

    expect(disk.schemaVersion).toBe(3);
    const [a, b, c] = disk.spaces[0].sources;
    expect(a).not.toHaveProperty("text");
    expect(isSourceTextRef(a.textRef)).toBe(true);
    expect(a.textRef).toMatchObject({ bytes: 17, chars: 13 });
    // Empty text stays inline; identical text is stored once.
    expect(b).toMatchObject({ text: "" });
    expect(b).not.toHaveProperty("textRef");
    expect(c.textRef).toEqual(a.textRef);
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(host.save).toHaveBeenCalledWith(["Alpha é😀 text"]);
    // The in-memory vault is untouched.
    expect(vault.schemaVersion).toBe(2);
    expect(vault.spaces[0].sources[0].text).toBe("Alpha é😀 text");
    expect(JSON.stringify(disk)).not.toContain("Alpha");
  });

  it("leaves a vault without source text exactly as it is", async () => {
    const { host } = fakeHost();
    const vault = vaultWith(source("empty", ""));
    expect(await createSourceTextStore(host).externalize(vault)).toBe(vault);
    expect(host.save).not.toHaveBeenCalled();
  });

  it("never sends or requests text this window already holds", async () => {
    const { host } = fakeHost();
    const store = createSourceTextStore(host);
    const vault = vaultWith(source("a", "first"), source("b", "second"));

    const disk = await store.externalize(vault);
    await store.externalize(vault);
    await store.externalize({ ...vault, updatedAt: "2026-11-02T00:00:00.000Z" });
    expect(host.save).toHaveBeenCalledTimes(1);

    // Reloading what was just saved needs nothing from the host and hands
    // back the very same strings, so merges compare them by identity.
    const loaded = await store.hydrate(throughDisk(disk)) as OrionVault;
    expect(host.load).not.toHaveBeenCalled();
    expect(loaded).toEqual(vault);
    expect(loaded.spaces[0].sources[0].text).toBe(vault.spaces[0].sources[0].text);

    // Only genuinely new text is stored.
    const grown = vaultWith(...vault.spaces[0].sources, source("c", "third"));
    await store.externalize(grown);
    expect(host.save).toHaveBeenCalledTimes(2);
    expect(host.save).toHaveBeenLastCalledWith(["third"]);
  });

  it("restores the in-memory model from disk, loading only unknown text", async () => {
    const { host } = fakeHost();
    const vault = vaultWith(source("a", "first"), source("b", "second"), source("c", ""));
    const disk = throughDisk(await createSourceTextStore(host).externalize(vault));

    // A different window: nothing cached yet.
    const store = createSourceTextStore(host);
    const loaded = await store.hydrate(disk) as OrionVault;
    expect(loaded).toEqual(vault);
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.spaces[0].sources.every((item) => !("textRef" in item))).toBe(true);
    expect(host.load).toHaveBeenCalledTimes(1);
    expect(host.load.mock.calls[0][0]).toHaveLength(2);

    // A later reload of the same file is free.
    await store.hydrate(throughDisk(await store.externalize(loaded)));
    expect(host.load).toHaveBeenCalledTimes(1);
    expect(host.save).toHaveBeenCalledTimes(1);
  });

  it("passes inline-text and unrecognised values through to the validator", async () => {
    const { host } = fakeHost();
    const store = createSourceTextStore(host);
    const inline = throughDisk(vaultWith(source("a", "inline")));
    expect(await store.hydrate(inline)).toBe(inline);
    for (const value of [null, "vault", [], { schemaVersion: 4, spaces: [] }, { schemaVersion: 3 }]) {
      expect(await store.hydrate(value)).toBe(value);
    }
    expect(host.load).not.toHaveBeenCalled();
  });

  it("fails closed on inconsistent references and incomplete host answers", async () => {
    const { host, files } = fakeHost();
    const store = createSourceTextStore(host);
    const disk = throughDisk(await store.externalize(vaultWith(source("a", "kept")))) as { spaces: { sources: Record<string, unknown>[] }[] };
    const withSource = (change: (record: Record<string, unknown>) => void) => {
      const copy = throughDisk(disk) as typeof disk;
      change(copy.spaces[0].sources[0]);
      return copy;
    };
    const fresh = () => createSourceTextStore(host);

    await expect(fresh().hydrate(withSource((record) => { record.text = "also inline"; }))).rejects.toThrow(/invalid source text reference/);
    await expect(fresh().hydrate(withSource((record) => { record.textRef = { sha256: "../../vault", bytes: 4, chars: 4 }; }))).rejects.toThrow(/invalid source text reference/);
    await expect(fresh().hydrate(withSource((record) => { record.textRef = { ...(record.textRef as object), path: "/etc/passwd" }; }))).rejects.toThrow(/invalid source text reference/);

    files.clear();
    await expect(fresh().hydrate(throughDisk(disk))).rejects.toThrow(SOURCE_TEXT_MISSING);

    host.load.mockResolvedValueOnce([]);
    await expect(fresh().hydrate(throughDisk(disk))).rejects.toThrow(/could not read/);
    host.save.mockResolvedValueOnce([{ sha256: "nope", bytes: 1, chars: 1 }]);
    await expect(fresh().externalize(vaultWith(source("b", "new")))).rejects.toThrow(/Nothing was saved/);
  });

  it("splits large libraries into bounded host requests", async () => {
    const { host } = fakeHost();
    const store = createSourceTextStore(host);
    const big = (seed: string) => seed.repeat(3 * 1024 * 1024);
    const vault = vaultWith(source("a", big("a")), source("b", big("b")), source("c", big("c")), source("d", big("d")));

    const disk = throughDisk(await store.externalize(vault));
    expect(host.save.mock.calls.map(([texts]) => texts.length)).toEqual([2, 2]);
    for (const [texts] of host.save.mock.calls) {
      expect(texts.reduce((total: number, text: string) => total + text.length, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    const loaded = await createSourceTextStore(host).hydrate(disk) as OrionVault;
    expect(loaded.spaces[0].sources.map((item) => item.text.length)).toEqual([big("a").length, big("b").length, big("c").length, big("d").length]);
  });

  it("serializes saves so a second save waits instead of resending text", async () => {
    const { host } = fakeHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = host.save.getMockImplementation()!;
    host.save.mockImplementationOnce(async (texts) => { await gate; return original(texts); });
    const store = createSourceTextStore(host);
    const vault = vaultWith(source("a", "slow to store"));

    const first = store.externalize(vault);
    const second = store.externalize(vault);
    release();
    await Promise.all([first, second]);
    expect(host.save).toHaveBeenCalledTimes(1);
  });

  it("forgets text that no saved or loaded vault has used for a while", async () => {
    const { host } = fakeHost();
    const store = createSourceTextStore(host);
    await store.externalize(vaultWith(source("gone", "deleted later")));
    const other = vaultWith(source("kept", "kept"));
    for (let index = 0; index < 20; index += 1) await store.externalize(other);
    expect(host.save).toHaveBeenCalledTimes(2);
    // The deleted source's text was released, so it is stored again if it returns.
    await store.externalize(vaultWith(source("gone", "deleted later")));
    expect(host.save).toHaveBeenCalledTimes(3);
  });

  it("can be told to store everything again", async () => {
    const { host } = fakeHost();
    const store = createSourceTextStore(host);
    const vault = vaultWith(source("a", "text"));
    await store.externalize(vault);
    store.forget();
    await store.externalize(vault);
    expect(host.save).toHaveBeenCalledTimes(2);
  });
});

describe("desktop vault storage boundary", () => {
  const invoke = vi.hoisted(() => vi.fn());
  vi.mock("@tauri-apps/api/core", () => ({ invoke }));

  let disk: unknown = null;
  let files: Map<string, string>;
  let counter: number;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    disk = null;
    files = new Map();
    counter = 0;
    invoke.mockReset();
    invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "load_vault") return disk === null ? null : throughDisk(disk);
      if (command === "save_vault") {
        const vault = args.vault as { spaces: { sources: { textRef?: SourceTextRef }[] }[] };
        for (const space of vault.spaces) for (const item of space.sources) {
          if (item.textRef && !files.has(item.textRef.sha256)) throw `${SOURCE_TEXT_MISSING}: the preserved text is not stored yet.`;
        }
        disk = throughDisk(vault);
        return undefined;
      }
      if (command === "save_source_texts") {
        return (args.texts as string[]).map((text) => {
          const existing = [...files].find(([, stored]) => stored === text)?.[0];
          const sha256 = existing ?? (++counter).toString(16).padStart(64, "0");
          files.set(sha256, text);
          return { sha256, bytes: new TextEncoder().encode(text).length, chars: [...text].length };
        });
      }
      if (command === "load_source_texts") return (args.references as SourceTextRef[]).map((item) => files.get(item.sha256));
      throw new Error(`unexpected command ${command}`);
    });
  });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);

  it("saves a vault without source text in it and loads it back whole", async () => {
    const { saveSnapshot, loadSnapshot } = await import("./storage");
    const vault = vaultWith(source("book", "A long preserved book."), source("blank", ""));

    await saveSnapshot(vault, null);
    expect(JSON.stringify(disk)).not.toContain("A long preserved book.");
    expect((disk as { schemaVersion: number }).schemaVersion).toBe(3);
    expect(calls("save_source_texts")).toHaveLength(1);

    expect(await loadSnapshot()).toEqual(vault);
    expect(calls("load_source_texts")).toHaveLength(0);

    // An ordinary note edit afterwards moves no source text at all.
    const edited = { ...vault, updatedAt: "2026-11-03T00:00:00.000Z" };
    await saveSnapshot(edited, vault.updatedAt);
    expect(calls("save_source_texts")).toHaveLength(1);
    expect(await loadSnapshot()).toEqual(edited);
  });

  it("migrates a library with inline text once, keeping its revision", async () => {
    const { loadSnapshot } = await import("./storage");
    const legacy = vaultWith(source("book", "Inline from an older version."));
    disk = throughDisk(legacy);

    expect(await loadSnapshot()).toEqual(legacy);
    await vi.waitFor(() => expect((disk as { schemaVersion: number }).schemaVersion).toBe(3));

    expect(calls("save_vault")).toHaveLength(1);
    expect(calls("save_vault")[0][1]).toMatchObject({ expectedUpdatedAt: legacy.updatedAt });
    expect((disk as OrionVault).updatedAt).toBe(legacy.updatedAt);
    expect(JSON.stringify(disk)).not.toContain("Inline from an older version.");
    expect([...files.values()]).toEqual(["Inline from an older version."]);
    // Later loads see the migrated file and do not save again.
    expect(await loadSnapshot()).toEqual(legacy);
    expect(calls("save_vault")).toHaveLength(1);
  });

  it("stores the text again and retries when the host reports it missing", async () => {
    const { saveSnapshot, loadSnapshot } = await import("./storage");
    const vault = vaultWith(source("book", "Removed from disk behind our back."));
    await saveSnapshot(vault, null);
    files.clear();

    const next = { ...vault, updatedAt: "2026-11-04T00:00:00.000Z" };
    await saveSnapshot(next, vault.updatedAt);
    expect(calls("save_vault")).toHaveLength(3);
    expect(calls("save_source_texts")).toHaveLength(2);
    expect([...files.values()]).toEqual(["Removed from disk behind our back."]);
    expect(await loadSnapshot()).toEqual(next);
  });

  it("keeps reporting other save failures unchanged", async () => {
    const { saveSnapshot } = await import("./storage");
    const vault = vaultWith(source("book", "text"));
    await saveSnapshot(vault, null);
    invoke.mockImplementationOnce(async () => { throw "ORION_VAULT_CONFLICT: Orion changed outside this window."; });
    await expect(saveSnapshot(vault, "stale")).rejects.toMatch(/ORION_VAULT_CONFLICT/);
  });

  it("sends workflow commits in the on-disk form", async () => {
    const { externalizeVaultForDisk } = await import("./storage");
    const committed = await externalizeVaultForDisk(vaultWith(source("book", "workflow text"))) as { schemaVersion: number };
    expect(committed.schemaVersion).toBe(3);
    expect(JSON.stringify(committed)).not.toContain("workflow text");
  });
});
