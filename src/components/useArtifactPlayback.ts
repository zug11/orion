import { useEffect, useRef, useState, type RefObject } from "react";

/** A local clock for an individual drawing. Explicit play begins at the
 * reader's current time; stopping or hiding the drawing freezes that pose. */
export function useArtifactPlayback(duration: number, loop: boolean, visible: boolean, host: RefObject<HTMLElement | null>, secondsPerPass = duration) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const position = useRef(0);
  const seek = (seconds: number) => {
    setPlaying(false);
    position.current = Math.max(0, Math.min(duration, seconds));
    setTime(position.current);
  };
  const toggle = () => {
    if (!playing && position.current >= duration) seek(0);
    setPlaying(value => !value);
  };
  useEffect(() => {
    if (!playing) return;
    const stop = () => setPlaying(false);
    if (!visible || document.hidden || duration <= 0) { stop(); return; }
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const started = performance.now(), initial = position.current;
    let frame = 0, lastPaint = -Infinity;
    const tick = (now: number) => {
      const elapsed = initial + Math.max(0, now - started) / (1000 * secondsPerPass) * duration;
      if (elapsed >= duration && (!loop || motion?.matches)) {
        position.current = duration; setTime(duration); stop(); return;
      }
      if (now - lastPaint >= 1000 / 30) {
        position.current = elapsed % duration;
        lastPaint = now;
        setTime(position.current);
      }
      frame = requestAnimationFrame(tick);
    };
    const hidden = () => { if (document.hidden) stop(); };
    const reduced = () => { if (motion?.matches) stop(); };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => !entry.isIntersecting)) stop();
    });
    if (host.current) observer?.observe(host.current);
    document.addEventListener("visibilitychange", hidden);
    motion?.addEventListener?.("change", reduced);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      motion?.removeEventListener?.("change", reduced);
    };
  }, [duration, secondsPerPass, loop, playing, visible, host]);
  return { time, seek, playing, toggle };
}
