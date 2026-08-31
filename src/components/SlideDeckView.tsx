import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  X,
} from "../lib/icons";
import type { DeckSlide } from "../lib/slideDeck";

interface SlideDeckViewProps {
  title: string;
  slides: readonly DeckSlide[];
  index?: number;
  onIndexChange?: (index: number) => void;
  playing?: boolean;
  onTogglePlay?: () => void;
  onExit?: () => void;
}

export function SlideDeckView({
  title,
  slides,
  index: controlledIndex,
  onIndexChange,
  playing = false,
  onTogglePlay,
  onExit,
}: SlideDeckViewProps) {
  const [uncontrolledIndex, setUncontrolledIndex] = useState(0);
  const [immersive, setImmersive] = useState(false);
  const total = slides.length;
  const index =
    controlledIndex === undefined
      ? uncontrolledIndex
      : Math.min(Math.max(0, controlledIndex), Math.max(0, total - 1));
  const setIndex = (next: number) => {
    const clamped = Math.min(Math.max(0, next), Math.max(0, total - 1));
    if (onIndexChange) onIndexChange(clamped);
    else setUncontrolledIndex(clamped);
  };
  const slide = slides[index];

  useEffect(() => {
    if (controlledIndex === undefined) setUncontrolledIndex(0);
  }, [slides, controlledIndex]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input, textarea, [contenteditable='true']") ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        if (onTogglePlay) {
          onTogglePlay();
          return;
        }
        setIndex(index + 1);
        return;
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        setIndex(index + 1);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setIndex(index - 1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (immersive) {
          setImmersive(false);
        } else {
          onExit?.();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersive, index, onExit, onTogglePlay, total]);

  if (!slide || total === 0) {
    return (
      <p className="slide-deck-empty">This deck has no slides yet.</p>
    );
  }

  return (
    <div
      className={immersive ? "slide-deck-view is-immersive" : "slide-deck-view"}
      data-testid="slide-deck-view"
      data-playing={playing ? "true" : "false"}
      aria-label={title}
    >
      <div className="slide-deck-stage">
        {slides.map((candidate, slideIndex) => {
          const active = slideIndex === index;
          return (
            <article
              key={`${slideIndex}:${candidate.imageSrc ?? candidate.title}`}
              className={[
                "slide-deck-card",
                candidate.imageSrc ? "has-plate" : "",
                active ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-hidden={active ? undefined : true}
              aria-live={active ? "polite" : undefined}
              aria-label={`Slide ${slideIndex + 1} of ${total}: ${candidate.title}`}
            >
              {candidate.imageSrc ? (
                <img
                  className="slide-deck-card__plate"
                  src={candidate.imageSrc}
                  alt={candidate.imageAlt || candidate.title}
                  decoding="async"
                />
              ) : (
                <div
                  className="slide-deck-card__plate is-empty"
                  aria-hidden="true"
                />
              )}
            </article>
          );
        })}
      </div>
      <div className="slide-deck-controls">
        {onTogglePlay ? (
          <button
            type="button"
            className={playing ? "icon-button active" : "icon-button"}
            aria-label={playing ? "Pause slideshow" : "Play slideshow"}
            aria-pressed={playing}
            title={playing ? "Pause slideshow" : "Play slideshow"}
            onClick={onTogglePlay}
          >
            {playing ? (
              <Pause size={16} />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button"
          aria-label="Previous slide"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          <ArrowLeft size={16} />
        </button>
        <span className="slide-deck-controls__count">
          {index + 1} / {total}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Next slide"
          disabled={index === total - 1}
          onClick={() => setIndex(index + 1)}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={immersive ? "Exit slideshow" : "Present slideshow"}
          onClick={() => setImmersive((value) => !value)}
        >
          {immersive ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        {immersive && onExit ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Close slideshow"
            onClick={() => {
              setImmersive(false);
              onExit();
            }}
          >
            <X size={15} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
