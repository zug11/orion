/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  buildDeckPlaybackCues,
  buildSlideImagePrompt,
  cueIndexAtElapsed,
  deckPlaybackDuration,
  isSlideDeckNote,
  parseDeckSlides,
  SLIDE_DECK_TAG,
  speakableSlideText,
  upcomingDeckSpeechTexts,
} from "./slideDeck";

describe("parseDeckSlides", () => {
  it("keeps titles, bullets, images, and image briefs without essay paragraphs", () => {
    const slides = parseDeckSlides(`
## Import topology

This long paragraph must not appear on the slide.

- Host owns the graph
- Six calls at a time
- Evidence stays local

Image: abstract architecture of stacked glass planes, no text

![Import topology](orion-image://localhost/image_abc123456789)

> Say this aloud if presenting.
`);
    expect(slides).toHaveLength(1);
    expect(slides[0]).toMatchObject({
      title: "Import topology",
      bullets: [
        "Host owns the graph",
        "Six calls at a time",
        "Evidence stays local",
      ],
      imageSrc: "orion-image://localhost/image_abc123456789",
      visualBrief: "abstract architecture of stacked glass planes, no text",
      notes: "Say this aloud if presenting.",
    });
  });

  it("recognizes the slide-deck tag", () => {
    expect(isSlideDeckNote({ tags: [SLIDE_DECK_TAG] })).toBe(true);
    expect(isSlideDeckNote({ tags: ["research"] })).toBe(false);
  });
});

describe("deck playback", () => {
  it("speaks speaker notes without announcing the slide title", () => {
    expect(
      speakableSlideText({
        title: "Import topology",
        bullets: ["Host owns the graph"],
        notes: "The host owns the graph and never fans out blindly.",
      }),
    ).toBe("The host owns the graph and never fans out blindly.");
    expect(
      speakableSlideText({
        title: "Import topology",
        bullets: [],
        notes: "Import topology. The host owns the graph.",
      }),
    ).toBe("The host owns the graph.");
  });

  it("falls back to bullets without the title when a slide has no notes", () => {
    expect(
      speakableSlideText({
        title: "Import topology",
        bullets: ["Host owns the graph", "Six calls at a time"],
      }),
    ).toBe("Host owns the graph. Six calls at a time");
  });

  it("builds a sequential timeline from speaker notes", () => {
    const cues = buildDeckPlaybackCues([
      {
        title: "One",
        bullets: [],
        notes: "Short.",
      },
      {
        title: "Two",
        bullets: [],
        notes: "A much longer spoken passage for the second slide.",
      },
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0].startSeconds).toBe(0);
    expect(cues[1].startSeconds).toBe(cues[0].durationSeconds);
    expect(cues[1].durationSeconds).toBeGreaterThan(cues[0].durationSeconds);
    expect(deckPlaybackDuration(cues)).toBe(
      cues[1].startSeconds + cues[1].durationSeconds,
    );
    expect(cueIndexAtElapsed(cues, 0)).toBe(0);
    expect(
      cueIndexAtElapsed(cues, cues[0].durationSeconds + 0.01),
    ).toBe(1);
    expect(upcomingDeckSpeechTexts(cues, 0, 2)).toEqual([
      cues[0].text,
      cues[1].text,
    ]);
    expect(upcomingDeckSpeechTexts(cues, 1, 3)).toEqual([cues[1].text]);
  });
});

describe("buildSlideImagePrompt", () => {
  it("asks image gen to letter title and bullets in distinctive fonts", () => {
    const result = buildSlideImagePrompt({
      deckTitle: "Space briefing",
      slideTitle: "Import topology",
      bullets: ["Host owns the graph", "Six calls at a time"],
      visualBrief: "stacked glass planes, no text",
    });
    expect(result.alt).toBe("Import topology");
    expect(result.prompt).toContain("finished 16:9 presentation slide");
    expect(result.prompt).toContain("visible lettering");
    expect(result.prompt).toContain("distinctive, interesting display fonts");
    expect(result.prompt).toContain("Letter this title");
    expect(result.prompt).toContain("Import topology");
    expect(result.prompt).toContain("Host owns the graph");
    expect(result.prompt).toContain("still letter the title and bullets");
    expect(result.prompt).toContain("generous margin");
    expect(result.prompt).not.toContain("No readable text");
    expect(result.prompt).not.toContain("HTML to add the words");
  });
});
