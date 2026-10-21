// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { PassageThreads } from "./PassageThreads";
import type { Note, PassageThread } from "../types";
const now = "2026-10-12T00:00:00.000Z";
function note(): Note {
  const thread: PassageThread = { id: "t", state: "open", anchor: { quote: "A precise passage.", text: "A precise passage." }, createdAt: now, updatedAt: now, messages: [{ id: "m", role: "assistant", content: "Consider the narrator’s distance.", createdAt: now }] };
  return { id: "n", title: "Draft", slug: "draft", body: "A precise passage.\n\nAnother paragraph.", summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: now, updatedAt: now, discussionThreads: [thread] };
}
let editor: Editor | undefined;
afterEach(() => { cleanup(); editor?.destroy(); editor = undefined; document.body.replaceChildren(); });
function readingRoot() { const root = document.createElement("article"); root.innerHTML = '<div data-voice-note-body="reading"><p>A precise passage.</p><p>Another paragraph.</p></div>'; document.body.append(root); return { current: root }; }
it("attaches a quiet icon below its passage and opens a separate floating chat without editing or sending", async () => {
  const root = readingRoot(), onAction = vi.fn().mockResolvedValue(undefined);
  render(<PassageThreads note={note()} root={root} editor={null} onAction={onAction} />);
  const icon = await screen.findByRole("button", { name: "Open passage discussion" });
  expect(icon.closest('[data-passage-thread]')?.previousElementSibling?.textContent).toBe("A precise passage.");
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(icon);
  const dialog = screen.getByRole("dialog", { name: "Comment" });
  expect(root.current.contains(dialog)).toBe(false);
  expect(icon.closest('[data-passage-thread]')?.querySelector("textarea")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Discuss this passage" })).toBeVisible();
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add to Note" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith("n", "t", expect.objectContaining({ kind: "addition", messageId: "m" })));
  expect(root.current.querySelector('p')?.textContent).toBe("A precise passage.");
});
it("keeps draft replies across dismissal and contains keyboard focus in the chat modal", async () => {
  const root = readingRoot(), onAction = vi.fn().mockResolvedValue(undefined);
  render(<PassageThreads note={note()} root={root} editor={null} onAction={onAction} />);
  const icon = await screen.findByRole("button", { name: "Open passage discussion" });
  fireEvent.click(icon);
  const input = screen.getByRole("textbox", { name: "Discuss this passage" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "What about the rhythm?" } });
  const send = screen.getByRole("button", { name: "Send message" }); send.focus();
  fireEvent.keyDown(send, { key: "Tab" }); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue in Chat" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(send);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(icon);
  fireEvent.click(icon); expect(screen.getByRole("textbox", { name: "Discuss this passage" })).toHaveValue("What about the rhythm?");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Discuss this passage" }), { key: "Enter", shiftKey: true }); expect(onAction).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Discuss this passage" }), { key: "Enter" });
  await waitFor(() => expect(onAction).toHaveBeenCalledWith("n", "t", expect.objectContaining({ kind: "reply", text: "What about the rhythm?" })));
});
it("queues an article directly without a raw title/body form and keeps pending comments separate", async () => {
  const root = readingRoot(), onAction = vi.fn().mockResolvedValue(undefined), current = note();
  const { rerender } = render(<PassageThreads note={current} root={root} editor={null} onAction={onAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate article" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith("n", "t", { kind: "create", messageId: "m" }));
  expect(screen.queryByRole("textbox", { name: "New note title" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Note text" })).toBeNull();
  expect(await screen.findByText("Article added to the generation queue.")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Discuss this passage" })).toBeVisible();
  rerender(<PassageThreads note={{ ...current, discussionThreads: [{ ...current.discussionThreads![0], state: "proposed" }] }} root={root} editor={null} onAction={onAction} />);
  expect(screen.getByRole("button", { name: "Accept comment" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Add to Note" })).toBeNull();
  screen.getByRole("button", { name: "Accept comment" }).focus();
  rerender(<PassageThreads note={current} root={root} editor={null} onAction={onAction} />);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Discuss this passage" }));
});
it("keeps a changed passage's thread available for reattachment", async () => {
  const root = readingRoot(), current = note(); current.body = "Changed.";
  render(<PassageThreads note={current} root={root} editor={null} onAction={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  expect(screen.getByRole("button", { name: "Attach to highlighted passage" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Suggest Rewrite" })).toBeNull();
});
it("uses decorations outside the Tiptap document and retains the model across thread updates", async () => {
  const element = document.createElement("div"); document.body.append(element);
  editor = new Editor({ element, extensions: [StarterKit], content: '<p>A precise passage.</p><p>Another paragraph.</p>' });
  const original = editor.getJSON(), current = note();
  const { rerender, unmount } = render(<PassageThreads note={current} root={{ current: element }} editor={editor} onAction={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  expect(editor.getJSON()).toEqual(original);
  const input = screen.getByRole("textbox", { name: "Discuss this passage" });
  fireEvent.change(input, { target: { value: "Keep my draft" } });
  rerender(<PassageThreads note={{ ...current, updatedAt: "later" }} root={{ current: element }} editor={editor} onAction={vi.fn()} />);
  expect(screen.getByRole("textbox", { name: "Discuss this passage" })).toHaveValue("Keep my draft");
  await act(async () => { editor!.commands.insertContentAt(1, "Changed "); });
  expect(editor.getHTML()).not.toContain("Consider the narrator");
  unmount(); expect(element.querySelector('[data-passage-thread]')).toBeNull();
});

it("preserves the active reading-thread composer when metadata arrives", async () => {
  const root = readingRoot(), current = note(), onAction = vi.fn();
  const { rerender } = render(<PassageThreads note={current} root={root} editor={null} onAction={onAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  const input = screen.getByRole("textbox", { name: "Discuss this passage" }); input.focus();
  fireEvent.change(input, { target: { value: "Keep writing" } });
  const updated = { ...current, discussionThreads: [{ ...current.discussionThreads![0], updatedAt: "later", messages: [...current.discussionThreads![0].messages, { id: "m2", role: "assistant" as const, content: "More context", createdAt: now }] }] };
  rerender(<PassageThreads note={updated} root={root} editor={null} onAction={onAction} />);
  expect(document.activeElement).toBe(input); expect(input).toHaveValue("Keep writing");
});

it("shows only Orion comments, styling actual follow-ups as replies without removing the contextual history", async () => {
  const current = note(), root = readingRoot();
  current.discussionThreads![0].messages.push(
    { id: "u", role: "user", content: "My private question about rhythm", createdAt: now },
    { id: "a", role: "assistant", content: "Let the second sentence breathe.", createdAt: now },
  );
  const original = structuredClone(current);
  render(<PassageThreads note={current} root={root} editor={null} onAction={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  expect(screen.getByRole("article", { name: "Orion comment" }).querySelector(".chat-message__identity")).toBeNull();
  expect(screen.getByRole("article", { name: "Orion reply" }).querySelector(".chat-message__identity")).toHaveTextContent("Orion");
  expect(screen.queryByText("My private question about rhythm")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Discuss this passage" })).toHaveAttribute("rows", "1");
  expect(current).toEqual(original);
});

it("shows a human opening comment and remains silent until a follow-up is submitted", async () => {
  const current = note(), onAction = vi.fn().mockResolvedValue(undefined);
  current.discussionThreads![0].messages[0] = { id: "human", role: "user", content: "Could the narrator be more distant?", createdAt: now };
  render(<PassageThreads note={current} root={readingRoot()} editor={null} onAction={onAction} openThreadId="t" />);
  expect(await screen.findByRole("dialog", { name: "Comment" })).toBeVisible();
  expect(screen.getByRole("article", { name: "Your comment" })).toHaveTextContent("YouCould the narrator be more distant?");
  expect(screen.queryByRole("article", { name: "Orion reply" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Ask Orion" })).toBeNull();
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Discuss this passage" }), { target: { value: "An unsent question" } });
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ask Orion about this passage" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
  expect(onAction).toHaveBeenCalledWith("n", "t", expect.objectContaining({ kind: "reply", text: "An unsent question" }));
});

it("continues the exact thread in Chat with its unsent draft and makes no reply request", async () => {
  const onAction = vi.fn().mockResolvedValue(undefined);
  render(<PassageThreads note={note()} root={readingRoot()} editor={null} onAction={onAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Discuss this passage" }), { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in Chat" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith("n", "t", { kind: "open-chat", draft: "Keep this draft" }));
  expect(onAction).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("gets out of the way as soon as an in-note review is ready, before its acceptance completes", async () => {
  let finish!: () => void;
  const onAction = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const root = readingRoot(), current = note();
  const { rerender } = render(<PassageThreads note={current} root={root} editor={null} onAction={onAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  fireEvent.click(screen.getByRole("button", { name: "Add to Note" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  rerender(<PassageThreads reviewActive note={current} root={root} editor={null} onAction={onAction} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => finish());
});

it("edits only the human annotation locally and offers explicit deletion", async () => {
  const current = note(), root = readingRoot(), onAction = vi.fn().mockResolvedValue(undefined);
  current.discussionThreads![0].messages[0].role = "user";
  render(<PassageThreads note={current} root={root} editor={null} onAction={onAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
  const input = screen.getByRole("textbox", { name: "Edit your comment" });
  fireEvent.change(input, { target: { value: "My revised thought." } });
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith("n", "t", { kind: "edit-comment", text: "My revised thought." }));
  fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith("n", "t", { kind: "delete" }));
});

it.each(["Backspace", "Delete"])("selects an adjacent marker before %s deletes it, retaining prose", async key => {
  const element = document.createElement("div"); document.body.append(element);
  editor = new Editor({ element, extensions: [StarterKit], content: '<p>A precise passage.</p><p>Another paragraph.</p>' });
  const onAction = vi.fn().mockResolvedValue(undefined), original = editor.getJSON();
  render(<PassageThreads note={note()} root={{ current: element }} editor={editor} onAction={onAction} />);
  const icon = await screen.findByRole("button", { name: "Open passage discussion" });
  act(() => editor!.commands.setTextSelection(key === "Backspace" ? 21 : 19));
  fireEvent.keyDown(editor.view.dom, { key });
  expect(document.activeElement).toBe(icon);
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.keyDown(icon, { key });
  await waitFor(() => expect(onAction).toHaveBeenCalledWith("n", "t", { kind: "delete" }));
  expect(editor.getJSON()).toEqual(original);
});

it("places cursor comments inside prose at the same position in editor and reading views", async () => {
  const current = note(); current.discussionThreads![0].anchor.cursor = { before: "A precise ", after: "passage.\nAnother paragraph." };
  const root = readingRoot(), action = vi.fn();
  const reading = render(<PassageThreads note={current} root={root} editor={null} onAction={action} />);
  let icon = await screen.findByRole("button", { name: "Open passage discussion" });
  expect(icon.closest('[data-passage-thread]')?.previousSibling?.textContent).toBe("A precise ");
  expect(icon.closest('[data-passage-thread]')?.nextSibling?.textContent).toBe("passage.");
  reading.unmount(); root.current.remove();
  const element = document.createElement("div"); document.body.append(element);
  editor = new Editor({ element, extensions: [StarterKit], content: '<p>A precise passage.</p><p>Another paragraph.</p>' });
  render(<PassageThreads note={current} root={{ current: element }} editor={editor} onAction={action} />);
  icon = await screen.findByRole("button", { name: "Open passage discussion" });
  expect(icon.closest('[data-passage-thread]')?.previousSibling?.textContent).toBe("A precise ");
  expect(editor.getText()).toBe("A precise passage.\n\nAnother paragraph.");
});

it("places multiple cursor comments in one reading paragraph without displacing text", async () => {
  const current = note(), root = readingRoot();
  const first = current.discussionThreads![0];
  first.anchor.cursor = { before: "A ", after: "precise passage.\nAnother paragraph." };
  current.discussionThreads!.push({ ...first, id: "t2", anchor: { ...first.anchor, cursor: { before: "A precise ", after: "passage.\nAnother paragraph." } } });
  render(<PassageThreads note={current} root={root} editor={null} onAction={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Open passage discussion" })).toHaveLength(2));
  expect(root.current.querySelector('[data-passage-thread="t"]')?.previousSibling?.textContent).toBe("A ");
  expect(root.current.querySelector('[data-passage-thread="t2"]')?.previousSibling?.textContent).toBe("precise ");
});
it("retains a cursor marker when its passage is edited, while requiring reattachment for AI changes", async () => {
  const current = note(); current.discussionThreads![0].anchor.cursor = { before: "A precise ", after: "passage.\nAnother paragraph." };
  current.body = "A precise revised passage.\n\nAnother paragraph.";
  const element = document.createElement("div"); document.body.append(element);
  editor = new Editor({element,extensions:[StarterKit],content:'<p>A precise revised passage.</p><p>Another paragraph.</p>'});
  render(<PassageThreads note={current} root={{current:element}} editor={editor} onAction={vi.fn()} />);
  const icon = await screen.findByRole("button",{name:"Open passage discussion"});
  expect(element.contains(icon)).toBe(true);
  fireEvent.click(icon);
  expect(screen.getByRole("button",{name:"Attach to highlighted passage"})).toBeVisible();
  expect(screen.queryByRole("button",{name:"Suggest Rewrite"})).toBeNull();
});
it("keeps a saved blank-line cursor comment above the following prose in reading view", async () => {
  const current = note(); current.body = '\n\n&nbsp;\n\ndsads\n\n\n\n&nbsp;';
  current.discussionThreads![0].anchor = {scope:'note',quote:'',text:'',cursor:{before:'\n',after:'\ndsads\n\n'}};
  const root = readingRoot(); root.current.innerHTML = '<div data-voice-note-body="reading"><p>&nbsp;</p><p>dsads</p><p>&nbsp;</p></div>';
  render(<PassageThreads note={current} root={root} editor={null} onAction={vi.fn()} />);
  const marker = await screen.findByRole('button',{name:'Open passage discussion'});
  expect(marker.closest('p')).toBe(root.current.querySelector('p'));
  expect(screen.queryByText('Passage changed or unavailable')).toBeNull();
});
