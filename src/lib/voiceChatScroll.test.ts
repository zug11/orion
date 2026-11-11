import { describe, expect, it } from "vitest";
import { consumeVoiceChatScroll, voiceChatPanelGeometry, VOICE_CHAT_REVEAL_DISTANCE } from "./voiceChatScroll";

describe("voice conversation reveal", () => {
  it("grows upward within the viewport and gives a sent prompt only its measured height", () => {
    const voice = voiceChatPanelGeometry(900, 200, 20);
    const preview = voiceChatPanelGeometry(900, 200, 20, 84);
    expect(voice).toEqual({ minimum: 440, maximum: 738, scene: 240 });
    expect(preview.minimum - voice.minimum).toBe(84);
    expect(preview.scene).toBe(voice.scene);
    expect(preview.maximum).toBe(voice.maximum);
    const longPrompt = voiceChatPanelGeometry(500, 220, 12, 2_000);
    expect(longPrompt.minimum).toBeLessThanOrEqual(longPrompt.maximum);
    expect(longPrompt.maximum).toBeLessThan(500 - 12);
    expect(longPrompt.scene).toBeGreaterThanOrEqual(64);
    expect(longPrompt.minimum - 220 - longPrompt.scene).toBeGreaterThanOrEqual(112);
  });

  it("uses one bounded reveal before native scrolling, including excess wheel movement", () => {
    expect(consumeVoiceChatScroll(0, 60, 0)).toEqual({ reveal: 60, handled: true, remainder: 0 });
    expect(consumeVoiceChatScroll(240, 100, 0)).toEqual({ reveal: 280, handled: true, remainder: 60 });
    expect(consumeVoiceChatScroll(280, 80, 0).handled).toBe(false);
    expect(consumeVoiceChatScroll(0, -80, 0)).toEqual({ reveal: 0, handled: true, remainder: 0 });
  });

  it("leaves the height alone while reading earlier messages and collapses only at the first message", () => {
    expect(consumeVoiceChatScroll(VOICE_CHAT_REVEAL_DISTANCE, -100, 2_000).handled).toBe(false);
    expect(consumeVoiceChatScroll(VOICE_CHAT_REVEAL_DISTANCE, -40, 0)).toEqual({ reveal: 240, handled: true, remainder: 0 });
  });
});
