import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadElevenLabsAccountVoices } from "./elevenLabsVoices";
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke, isTauri: () => true }));
const voice = { id: "abcdefgh12345678", name: "Reading", requiresVerification: false };
beforeEach(() => api.invoke.mockReset());
describe("complete ElevenLabs account catalog", () => {
  it("follows all pages and deduplicates IDs without dropping verification", async () => {
    api.invoke.mockResolvedValueOnce({ voices: [voice], nextPage: "page2" }).mockResolvedValueOnce({ voices: [{ ...voice, requiresVerification: true }, { ...voice, id: "ijklmnop12345678", name: "\u0000New voice\u0085" }], nextPage: null });
    expect(await loadElevenLabsAccountVoices(() => true)).toEqual([{ ...voice, requiresVerification: true }, { ...voice, id: "ijklmnop12345678", name: "New voice" }]);
    expect(api.invoke).toHaveBeenLastCalledWith("elevenlabs_list_voices", { nextPage: "page2" });
  });
  it("does not return partial coverage after repeated pagination", async () => {
    api.invoke.mockResolvedValue({ voices: [voice], nextPage: "same" });
    await expect(loadElevenLabsAccountVoices(() => true)).rejects.toThrow("repeated");
    expect(api.invoke).toHaveBeenCalledTimes(2);
  });
  it("bounds a library that never ends without silently accepting a prefix", async () => {
    let page = 0; api.invoke.mockImplementation(async () => ({ voices: [voice], nextPage: `${++page}` }));
    await expect(loadElevenLabsAccountVoices(() => true)).rejects.toThrow("fully loaded");
    expect(api.invoke).toHaveBeenCalledTimes(20);
  });
  it("abandons an old key's result before requesting another page", async () => {
    let active = true;
    api.invoke.mockImplementation(async () => { active = false; return { voices: [voice], nextPage: "next" }; });
    expect(await loadElevenLabsAccountVoices(() => active)).toBeUndefined();
    expect(api.invoke).toHaveBeenCalledOnce();
  });
  it.each([{ ...voice, requiresVerification: undefined }, { ...voice, id: "../invalid" }])("rejects malformed catalog entries", async invalid => {
    api.invoke.mockResolvedValue({ voices: [invalid], nextPage: null });
    await expect(loadElevenLabsAccountVoices(() => true)).rejects.toThrow("invalid voice");
  });
});
