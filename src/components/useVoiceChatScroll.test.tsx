// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceChatScroll } from "./useVoiceChatScroll";

function Conversation({ content = false, reply = "", visible = true, active = true }: { content?: boolean; reply?: string; visible?: boolean; active?: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scroll = useVoiceChatScroll({ enabled: active, active, visible, hasContent: content, replyKey: reply, contentKey: String(content) + reply, panelRef });
  return <div><div ref={panelRef} data-testid="panel">
    <header className="chat-dock__header" />
    <div ref={scroll.stageRef} data-testid="stage" tabIndex={0}>
      <button className="chat-view__conversation-cue" onClick={() => scroll.showMessages()}>Conversation</button>
      <div ref={scroll.threadRef} data-testid="thread" tabIndex={0} style={{ padding: 14 }}>
        <div ref={scroll.contentRef} className="chat-view__thread-content">{content && <article className="chat-message--user">A short prompt</article>}</div>
      </div>
      <div className="chat-view__voice-controls" />
      <form className="chat-composer"><textarea aria-label="Draft" /></form>
    </div>
    <button onClick={scroll.previewPrompt}>Send</button>
    <button onClick={scroll.showVoice}>Voice</button>
    {scroll.newReply && <button onClick={() => scroll.showMessages(true)}>New reply</button>}
  </div></div>;
}
function height() { return parseFloat(screen.getByTestId("panel").style.getPropertyValue("--chat-scroll-height")); }
async function frame() { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const heights: Record<string, number> = { "chat-dock__header": 50, "chat-view__voice-controls": 48, "chat-composer": 100, "chat-message--user": 56 };
    const height = heights[this.className] ?? 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 390, bottom: height, width: 390, height, toJSON() {} };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("voice conversation scroll interaction", () => {
  it("has no empty chat reveal, fits a submitted prompt, and leaves arriving replies for the reader", async () => {
    const { rerender } = render(<Conversation />);
    expect(height()).toBe(440);
    expect(fireEvent.wheel(screen.getByTestId("stage"), { deltaY: 100 })).toBe(false);
    fireEvent.keyDown(screen.getByTestId("stage"), { key: "End" }); await frame();
    expect(height()).toBe(440);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    rerender(<Conversation content />); await frame();
    expect(height()).toBe(440 + 56 + 28);
    rerender(<Conversation content reply="A long answer has arrived" />); await frame();
    expect(height()).toBe(524);
    expect(screen.getByRole("button", { name: "New reply" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New reply" }));
    expect(height()).toBe(738);
    expect(screen.getByTestId("thread")).toHaveFocus();
  });

  it("expands on a wheel gesture but shrinks only beyond the first message, leaving the composer alone", async () => {
    render(<Conversation content />);
    const stage = screen.getByTestId("stage"), thread = screen.getByTestId("thread");
    expect(fireEvent.wheel(screen.getByRole("textbox"), { deltaY: 300 })).toBe(true);
    expect(height()).toBe(440);
    expect(fireEvent.wheel(stage, { deltaY: 140 })).toBe(false); await frame();
    expect(height()).toBe(589);
    fireEvent.wheel(stage, { deltaY: 180 }); await frame();
    expect(height()).toBe(738); expect(thread.scrollTop).toBe(40);
    thread.scrollTop = 200;
    expect(fireEvent.wheel(thread, { deltaY: -60 })).toBe(true); await frame();
    expect(height()).toBe(738);
    thread.scrollTop = 0;
    expect(fireEvent.wheel(thread, { deltaY: -140 })).toBe(false); await frame();
    expect(height()).toBe(589);
    fireEvent.wheel(stage, { deltaY: -140 }); await frame();
    expect(height()).toBe(440);
  });

  it("keeps reading position through collapse, offers keyboard access, and resets after ending voice", async () => {
    const { rerender, unmount } = render(<Conversation content />);
    const stage = screen.getByTestId("stage"), panel = screen.getByTestId("panel");
    fireEvent.keyDown(stage, { key: "PageDown" }); await frame(); expect(height()).toBe(738);
    rerender(<Conversation content visible={false} reply="While hidden" />);
    expect(panel.style.getPropertyValue("--chat-scroll-height")).toBe("");
    rerender(<Conversation content reply="While hidden" />);
    expect(height()).toBe(738);
    expect(screen.getByRole("button", { name: "New reply" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("thread"), { key: "Home" });
    expect(height()).toBe(440);
    expect(screen.getByRole("button", { name: "Conversation" })).toHaveFocus();
    rerender(<Conversation content active={false} />);
    expect(panel).not.toHaveAttribute("data-voice-scroll");
    rerender(<Conversation content />); expect(height()).toBe(440);
    unmount(); expect(panel.style.getPropertyValue("--chat-scroll-height")).toBe("");
  });
});
