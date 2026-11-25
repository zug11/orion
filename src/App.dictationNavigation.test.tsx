// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Editor } from "@tiptap/core";
import type { Note, OrionVault } from "./types";
import { createEmptySnapshot, createEmptyVault } from "./data/defaults";

const runtime = vi.hoisted(() => ({
  disk: null as OrionVault | null,
  load: vi.fn(),
  save: vi.fn(),
  invoke: vi.fn(),
  stopTrack: vi.fn(),
}));

vi.mock("./lib/storage", async (original) => ({
  ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true,
  loadSnapshot: runtime.load,
  saveSnapshot: runtime.save,
  startVoiceMemoSession: vi.fn().mockResolvedValue(undefined),
  finishVoiceMemoSession: vi.fn().mockResolvedValue(undefined),
  transcribeVoiceMemo: vi.fn().mockResolvedValue({text:"Recorded original speech."}),
}));
vi.mock("./lib/useResolvedTheme", async () => {
  const { resolveThemePalette } = await import("./lib/theme");
  const { defaultSettings } = await import("./data/defaults");
  const palette = resolveThemePalette(defaultSettings, "dark");
  return { useResolvedTheme: () => ({ palette, glassStatus: null }) };
});
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: (p: {onViewChange:(view:"home")=>void;onOpenNote:(id:string)=>void;onSwitchSpace:(id:string)=>void}) => <aside>
<button onClick={()=>p.onViewChange('home')}>Go Home</button>
<button onClick={()=>p.onOpenNote('note-one')}>Open first</button>
<button onClick={()=>p.onOpenNote('note-two')}>Open second</button>
<button onClick={()=>p.onSwitchSpace('other-space')}>Other Space</button>
</aside> }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
class Recorder {
  static isTypeSupported(){return true;}
  state:RecordingState='inactive';ondataavailable:((e:BlobEvent)=>void)|null=null;onstop:(()=>void)|null=null;
  start(){this.state='recording';}
  stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'])} as BlobEvent);this.onstop?.();}
}

import App from "./App";

beforeEach(() => {
  runtime.stopTrack.mockReset();
  vi.stubGlobal("MediaRecorder",Recorder);
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop:runtime.stopTrack}]})}});
  runtime.load.mockReset();
  runtime.save.mockReset();
  runtime.invoke.mockReset().mockResolvedValue(undefined);
  mockIPC((command, payload) => runtime.invoke(command, payload), { shouldMockEvents: true });
  mockWindows("main");
  const vault = createEmptyVault("Window test");
  vault.spaces[0].notes = ["one", "two"].map((name): Note => ({
    id: `note-${name}`, title: `Document ${name}`, slug: `document-${name}`, body: `Body ${name}`, summary: "",
    kind: "article", status: "ready", tags: [], aliases: [], conceptIds: [], sourceIds: [],
    createdAt: vault.updatedAt, updatedAt: vault.updatedAt,
  }));
  const other=createEmptySnapshot("Other",vault.updatedAt,"other-space");
  other.notes=[{...vault.spaces[0].notes[0],body:"Other Space text"}];vault.spaces.push(other);
  runtime.disk = vault;
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault) => { runtime.disk = structuredClone(next); });
});

afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  clearMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function launch() {
  const spaceId = runtime.disk!.activeSpaceId;
  window.history.replaceState(null, "", `/?space=${spaceId}&note=note-one`);
  render(<App />);
  await screen.findByRole("heading", { name: "Document one" });
  await waitFor(() => expect(runtime.save).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', {name:'Edit'}));
  return (await screen.findByRole('textbox', {name:'Note body'}) as HTMLElement & {editor:Editor}).editor;
}

describe('dictation navigation in App',()=>{
  it('retains the original recording across Home and another note, then saves only to its origin',async()=>{
    const origin = await launch();
    act(() => { origin.commands.setTextSelection(5); });
    const before = origin.state.doc;
    fireEvent.click(screen.getByRole('button',{name:'Start dictation'}));
    await screen.findByRole('button',{name:/Stop dictation/});
    fireEvent.click(screen.getByRole('button',{name:'Go Home'}));
    expect(await screen.findByRole('region',{name:'Background dictation'})).toBeVisible();
    expect(runtime.stopTrack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Open second'}));
    await screen.findByRole('heading',{name:'Document two'});
    fireEvent.click(screen.getByRole('button', {name:'Edit'}));
    const otherBody = await screen.findByRole('textbox',{name:'Note body'});
    const other = (otherBody as HTMLElement & {editor:Editor}).editor;
    act(() => {
      other.view.focus();
      other.commands.insertContentAt(other.state.doc.content.size - 1, ' — still writing');
    });
    expect(screen.getByRole('button',{name:'Start dictation'})).toBeDisabled();
    expect(origin.isDestroyed).toBe(false);
    fireEvent.click(within(screen.getByRole('region',{name:'Background dictation'})).getByRole('button',{name:/Stop dictation/}));
    await waitFor(()=>expect(runtime.disk!.spaces[0].notes[0].body).toBe('Body Recorded original speech. one'));
    expect(otherBody).toHaveFocus();
    expect(other.getMarkdown()).toBe('Body two — still writing');
    expect(runtime.disk!.spaces[0].notes[1].body).toBe('Body two — still writing');
    expect(runtime.disk!.spaces[1].notes[0].body).toBe('Other Space text');
    expect(runtime.disk!.spaces[0].sources[0].text).toBe('Recorded original speech.');
    expect(runtime.disk!.spaces[0].notes[0].sourceIds).toContain(runtime.disk!.spaces[0].sources[0].id);
    expect(runtime.stopTrack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button',{name:'Open first'}));
    const returned = await screen.findByRole('textbox',{name:'Note body'});
    expect((returned as HTMLElement & {editor:Editor}).editor).toBe(origin);
    act(() => { expect(origin.commands.undo()).toBe(true); });
    expect(origin.state.doc.eq(before)).toBe(true);
    await waitFor(()=>expect(runtime.disk!.spaces[0].notes[0].body).toBe('Body one'));
    expect(runtime.disk!.spaces[0].sources[0].text).toBe('Recorded original speech.');
  });
  it('stops on a Space switch and preserves original speech without inserting into either Space',async()=>{
    await launch();
    fireEvent.click(screen.getByRole('button',{name:'Start dictation'}));
    await screen.findByRole('button',{name:/Stop dictation/});
    fireEvent.click(screen.getByRole('button',{name:'Other Space'}));
    await waitFor(()=>expect(runtime.stopTrack).toHaveBeenCalledOnce());
    await waitFor(()=>expect(runtime.disk!.spaces[0].sources).toHaveLength(1));
    expect(runtime.disk!.spaces[0].notes[0].body).toBe('Body one');
    expect(runtime.disk!.spaces[1].notes[0].body).toBe('Other Space text');
    expect(runtime.disk!.spaces[1].sources).toHaveLength(0);
    expect(screen.queryByRole('region',{name:'Background dictation'})).toBeNull();
  });
});
