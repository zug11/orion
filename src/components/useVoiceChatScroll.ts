import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { consumeVoiceChatScroll, voiceChatPanelGeometry, VOICE_CHAT_REVEAL_DISTANCE } from "../lib/voiceChatScroll";

type Phase = "voice" | "revealing" | "messages";
interface Options {
  enabled: boolean;
  active: boolean;
  visible: boolean;
  hasContent: boolean;
  replyKey: string;
  contentKey: string;
  panelRef?: RefObject<HTMLDivElement | null>;
}

/** Presentation only. The call, composer and transcript stay mounted. Scroll
 * frames update CSS locally; they never rerender the conversation or vault. */
export function useVoiceChatScroll(options: Options) {
  const stageRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const live = useRef(options); live.current = options;
  const reveal = useRef(0);
  const followLatest = useRef(false);
  const frame = useRef(0);
  const pendingScroll = useRef(0);
  const animation = useRef(0);
  const geometry = useRef({ minimum: 440, maximum: 600, scene: 220 });
  const phaseRef = useRef<Phase>("voice");
  const [phase, setPhase] = useState<Phase>("voice");
  const [newReply, setNewReply] = useState(false);
  const lastReply = useRef(options.replyKey);
  const previewAnchor = useRef(false);
  const [peeking, setPeeking] = useState(false);
  const refresh = useRef(() => {});

  function previewArticle() {
    const articles = contentRef.current?.querySelectorAll<HTMLElement>(":scope > .chat-message--user");
    return articles?.[articles.length - 1];
  }

  function anchorPrompt() {
    const thread = threadRef.current, content = contentRef.current, article = previewArticle();
    if (!thread || !content || !article || !previewAnchor.current) return;
    const padding = getComputedStyle(thread);
    const top = Number.parseFloat(padding.paddingTop) || 0, bottom = Number.parseFloat(padding.paddingBottom) || 0;
    const nav = thread.querySelector<HTMLElement>(".chat-view__reading-nav");
    const navigationHeight = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().height + 12 : 0;
    // When the reader reveals a short prompt, keep it in place instead of
    // exposing older messages as the viewport grows. This space is consumed by
    // the arriving answer; it never makes the initial prompt preview taller.
    const remaining = content.getBoundingClientRect().bottom - article.getBoundingClientRect().top;
    thread.style.setProperty("--chat-prompt-tail", `${Math.max(0, thread.clientHeight - top - bottom - navigationHeight - remaining)}px`);
    if (reveal.current < VOICE_CHAT_REVEAL_DISTANCE) {
      thread.scrollTop += article.getBoundingClientRect().top - thread.getBoundingClientRect().top - top - navigationHeight;
    }
  }

  function clearPreview() {
    previewAnchor.current = false; setPeeking(false);
    threadRef.current?.style.removeProperty("--chat-prompt-tail");
  }

  function paint() {
    const panel = live.current.panelRef?.current, stage = stageRef.current;
    if (!panel || !stage || !live.current.enabled || !live.current.visible) return;
    const progress = reveal.current / VOICE_CHAT_REVEAL_DISTANCE;
    panel.style.setProperty("--chat-scroll-height", `${geometry.current.minimum + (geometry.current.maximum - geometry.current.minimum) * progress}px`);
    stage.style.setProperty("--chat-scroll-scene", `${geometry.current.scene * (1 - progress)}px`);
    stage.style.setProperty("--chat-scroll-progress", String(progress));
    const next: Phase = progress === 0 ? "voice" : progress === 1 ? "messages" : "revealing";
    stage.dataset.scrollPhase = next;
    if (phaseRef.current !== next) { phaseRef.current = next; setPhase(next); }
    anchorPrompt();
  }

  function scrollLatest() {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  function schedulePaint(remainder = 0) {
    pendingScroll.current += remainder;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      paint();
      if (pendingScroll.current && threadRef.current) threadRef.current.scrollTop += pendingScroll.current;
      pendingScroll.current = 0;
    });
  }

  function animateTo(target: number, finished?: () => void) {
    cancelAnimationFrame(animation.current); cancelAnimationFrame(frame.current);
    frame.current = 0; pendingScroll.current = 0;
    const start = reveal.current;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || start === target) {
      reveal.current = target; paint(); finished?.(); return;
    }
    let began: number | undefined;
    const step = (now: number) => {
      began ??= now;
      const progress = Math.min(1, (now - began) / 240);
      reveal.current = start + (target - start) * (1 - (1 - progress) ** 3);
      paint();
      if (progress < 1) animation.current = requestAnimationFrame(step);
      else { animation.current = 0; finished?.(); }
    };
    animation.current = requestAnimationFrame(step);
  }

  function showMessages(latest = false, focus = true) {
    if (!live.current.enabled || !live.current.hasContent) return;
    followLatest.current = latest;
    if (latest) clearPreview();
    setNewReply(false);
    animateTo(VOICE_CHAT_REVEAL_DISTANCE, () => {
      if (latest) scrollLatest();
      if (focus) threadRef.current?.focus({ preventScroll: true });
    });
  }

  function showVoice() {
    followLatest.current = false;
    clearPreview(); refresh.current();
    animateTo(0, () => {
      if (threadRef.current) threadRef.current.scrollTop = 0;
      stageRef.current?.querySelector<HTMLButtonElement>(".chat-view__conversation-cue")?.focus({ preventScroll: true });
    });
  }

  function previewPrompt() {
    if (!live.current.enabled) return;
    setNewReply(false);
    if (reveal.current === 0) {
      previewAnchor.current = true; setPeeking(true);
      followLatest.current = false;
      // The pending prompt mounts in the same React update as this request.
      frame.current = requestAnimationFrame(() => { frame.current = 0; refresh.current(); });
    } else {
      clearPreview(); followLatest.current = true;
      showMessages(true, false);
    }
  }

  useLayoutEffect(() => {
    if (!options.active) { reveal.current = 0; followLatest.current = false; setNewReply(false); clearPreview(); }
  }, [options.active]);

  useLayoutEffect(() => {
    const panel = options.panelRef?.current, stage = stageRef.current, thread = threadRef.current;
    if (!options.enabled || !options.visible || !panel || !stage || !thread) return;
    panel.dataset.voiceScroll = "true";
    // Start a call at the voice introduction, not at a previously auto-scrolled reply.
    if (reveal.current < VOICE_CHAT_REVEAL_DISTANCE && !previewAnchor.current) thread.scrollTop = 0;
    function measure() {
      const header = panel!.querySelector<HTMLElement>(".chat-dock__header");
      const controls = stage!.querySelector<HTMLElement>(".chat-view__voice-controls");
      const composer = stage!.querySelector<HTMLElement>(".chat-composer");
      const chrome = 2 + (header?.getBoundingClientRect().height ?? 0) + (controls?.getBoundingClientRect().height ?? 0) + (composer?.getBoundingClientRect().height ?? 0);
      const bottom = Number.parseFloat(getComputedStyle(panel!.parentElement!).bottom) || 20;
      const article = previewAnchor.current ? previewArticle() : undefined;
      const padding = getComputedStyle(thread!);
      const promptHeight = article ? article.getBoundingClientRect().height + (Number.parseFloat(padding.paddingTop) || 0) + (Number.parseFloat(padding.paddingBottom) || 0) : 0;
      geometry.current = voiceChatPanelGeometry(window.visualViewport?.height ?? window.innerHeight, chrome, bottom, promptHeight);
      paint();
      if (followLatest.current && reveal.current === VOICE_CHAT_REVEAL_DISTANCE) scrollLatest();
    }
    refresh.current = measure;
    measure();
    // These heights can change for errors, selections and zoom.
    // Observing the panel itself would create feedback during its scroll resize.
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    for (const child of [panel.querySelector(".chat-dock__header"), stage.querySelector(".chat-view__voice-controls"), stage.querySelector(".chat-composer")]) {
      if (child) resize?.observe(child);
    }
    const contentResize = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (previewAnchor.current) measure();
      if (followLatest.current && reveal.current === VOICE_CHAT_REVEAL_DISTANCE) scrollLatest();
    }) : undefined;
    if (contentRef.current) contentResize?.observe(contentRef.current);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);

    const excluded = (target: EventTarget | null) => !(target instanceof Element) || !!target.closest(".chat-composer,.chat-view__voice-controls,[role=dialog],[role=menu],input,textarea,select,[contenteditable=true]");
    function nestedCanScroll(target: Element, delta: number) {
      for (let node: Element | null = target; node && node !== thread && node !== stage; node = node.parentElement) {
        if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(node).overflowY)) continue;
        if (delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      }
      return false;
    }
    function consume(delta: number, target: EventTarget | null) {
      if (!Number.isFinite(delta) || !delta || excluded(target) || nestedCanScroll(target as Element, delta)) return false;
      if (!live.current.hasContent) return true;
      const next = consumeVoiceChatScroll(reveal.current, delta, thread!.scrollTop);
      if (!next.handled) return false;
      cancelAnimationFrame(animation.current); animation.current = 0;
      followLatest.current = false;
      if (reveal.current === VOICE_CHAT_REVEAL_DISTANCE && delta < 0) { clearPreview(); measure(); }
      reveal.current = next.reveal;
      if (next.reveal < VOICE_CHAT_REVEAL_DISTANCE && !previewAnchor.current) thread!.scrollTop = 0;
      schedulePaint(next.remainder);
      return true;
    }
    function wheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? thread!.clientHeight || 300 : 1;
      if (consume(event.deltaY * scale, event.target)) event.preventDefault();
    }
    function key(event: globalThis.KeyboardEvent) {
      if (event.target !== thread && event.target !== stage || event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === "Home") { event.preventDefault(); showVoice(); return; }
      if (event.key === "End") { event.preventDefault(); showMessages(true); return; }
      const delta = event.key === "ArrowDown" ? 40 : event.key === "ArrowUp" ? -40 : event.key === "PageDown" || event.key === " " && !event.shiftKey ? 280 : event.key === "PageUp" || event.key === " " && event.shiftKey ? -280 : 0;
      if (consume(delta, event.target)) event.preventDefault();
    }
    let touchY: number | undefined;
    const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 && !excluded(event.target) && !(event.target as Element).closest("button,.voice-constellation") ? event.touches[0].clientY : undefined; };
    const touchMove = (event: TouchEvent) => {
      if (touchY === undefined || event.touches.length !== 1) return;
      const delta = touchY - event.touches[0].clientY; touchY = event.touches[0].clientY;
      if (consume(delta, event.target)) event.preventDefault();
    };
    function scroll() {
      if (reveal.current !== VOICE_CHAT_REVEAL_DISTANCE || animation.current) return;
      followLatest.current = thread!.scrollHeight - thread!.clientHeight - thread!.scrollTop < 32;
      if (followLatest.current) setNewReply(false);
    }
    stage.addEventListener("wheel", wheel, { passive: false });
    stage.addEventListener("keydown", key);
    stage.addEventListener("touchstart", touchStart, { passive: true });
    stage.addEventListener("touchmove", touchMove, { passive: false });
    thread.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame.current); cancelAnimationFrame(animation.current);
      frame.current = animation.current = 0;
      pendingScroll.current = 0;
      resize?.disconnect(); contentResize?.disconnect();
      window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure);
      stage.removeEventListener("wheel", wheel); stage.removeEventListener("keydown", key);
      stage.removeEventListener("touchstart", touchStart); stage.removeEventListener("touchmove", touchMove);
      thread.removeEventListener("scroll", scroll);
      delete panel.dataset.voiceScroll;
      panel.style.removeProperty("--chat-scroll-height");
      refresh.current = () => {};
    };
    // Content updates use live refs; they must not restart scroll listeners or motion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, options.visible, options.panelRef]);

  useLayoutEffect(() => {
    if (!options.enabled) { lastReply.current = options.replyKey; return; }
    if (options.replyKey !== lastReply.current) {
      lastReply.current = options.replyKey;
      if (!followLatest.current || reveal.current < VOICE_CHAT_REVEAL_DISTANCE || !options.visible) setNewReply(true);
    }
    if (options.visible && followLatest.current && reveal.current === VOICE_CHAT_REVEAL_DISTANCE) scrollLatest();
    if (previewAnchor.current) refresh.current();
  }, [options.replyKey, options.contentKey, options.enabled, options.visible]);

  useEffect(() => () => { cancelAnimationFrame(frame.current); cancelAnimationFrame(animation.current); }, []);
  return { stageRef, threadRef, contentRef, phase, peeking, newReply, showMessages, showVoice, previewPrompt };
}
