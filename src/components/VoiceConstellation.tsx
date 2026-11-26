import type { Settings } from "../types";
import { resolveAtmospherePalette } from "../lib/homeAtmosphere";
import { resolveThemeMode, resolveThemePalette } from "../lib/theme";
import { createVoiceGlass } from "./voiceShaders/renderer";
import { VoiceOrbRotation } from "./voiceShaders/rotation";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { VoiceActivity, VoiceStatus } from "../lib/liveVoice";
import type { VoiceWorkOrder } from "../lib/voiceResearch";
import type { IconPalette } from "../lib/themeIcon";
import { VoiceOrbMotion, VOICE_ORB_UPDATE_FLIGHT_SECONDS, projectVoiceOrbs, unprojectVoiceOrbPoint, type OrbCircle } from "../lib/voiceOrbMotion";
import "./VoiceConstellation.css";

export interface VoiceConstellationProps {
  settings?: Settings;
  status: VoiceStatus;
  activity: VoiceActivity;
  muted: boolean;
  thinking?: boolean;
  jobs: readonly VoiceWorkOrder[];
  focusedJobId?: string;
  dismissedJobIds?: readonly string[];
  onFocus: (id: string | undefined) => void;
  onDismiss: (id: string) => void;
  size?: "pill" | "expanded" | "sidebar";
  palette?: IconPalette;
  interactive?: boolean;
  /** A paused demonstration can hold ambient time while controls remain interactive. */
  ambientPaused?: boolean;
  /** Keep the visible scene's motion when its UI moves between Chat and the pill. */
  motion?: VoiceOrbMotion;
  /** Opens the conversation when the scene cannot offer clear targets. */
  onShowConversation?: () => void;
}
type RGB = readonly [number, number, number];
const blend = (a: RGB, b: RGB, amount: number): RGB => a.map((value, index) => Math.round(value + (b[index] - value) * amount)) as unknown as RGB;
const color = (rgb: RGB, alpha = 1) => `rgba(${rgb.join(",")},${alpha})`;
const white: RGB = [255, 255, 255];
function lightGlassTint(rgb: RGB, lightness: number, saturation: number): RGB {
  const luma = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  const chroma = rgb.map(channel => (channel - luma) * saturation);
  const scale = Math.max(1, ...chroma.map(channel => Math.max(channel / (255 - lightness), -channel / lightness)));
  return chroma.map(channel => Math.round(lightness + channel / scale)) as unknown as RGB;
}
const workerTint: RGB[] = [[115, 211, 204], [223, 179, 132], [174, 156, 235], [218, 128, 147], [138, 176, 230], [195, 207, 133]];
function workerLabel(job: VoiceWorkOrder) {
  if (job.state !== "running") return job.state === "completed" && job.result ? "Open worker conversation" : job.state;
  const status = job.phase === "queued" ? "Queued; waiting to begin research" : job.phase === "routing" ? "Understanding request; research has not started" : job.phase === "clarifying" ? "Waiting for details; research has not started" : "Researching";
  return `${status}; drag out or press Delete to cancel`;
}
function cssPalette(element: HTMLElement): IconPalette {
  const css = getComputedStyle(element), accent = css.getPropertyValue("--periwinkle").trim();
  const body: RGB = /^#[\da-f]{6}$/i.test(accent) ? [1, 3, 5].map(offset => parseInt(accent.slice(offset, offset + 2), 16)) as unknown as RGB : [143, 159, 225];
  return { body, shadow: blend(body, [17, 22, 36], .62), highlight: blend(body, [232, 240, 242], .55), background: "transparent" };
}

/** Live voice presence. PCM levels and real work transitions drive the animation;
 * it never starts a microphone, provider request, timer demo, or note mutation. */
export function VoiceConstellation(props: VoiceConstellationProps) {
  const latest = useRef(props); latest.current = { ...props, jobs: props.jobs.filter(job => !job.provisional) };
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const bodyMeasure = useRef<HTMLSpanElement>(null);
  const model = useRef<VoiceOrbMotion | null>(null);
  if (model.current === null) model.current = new VoiceOrbMotion();
  const motion = props.motion ?? model.current;
  const targets = useRef(new Map<string, HTMLButtonElement>());
  const centreTarget = useRef<HTMLButtonElement>(null);
  const gesture = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean } | undefined>(undefined);
  const projection = useRef({ fit: 1, x: 1, y: 1 });
  const shaderHover = useRef<{ rotation: VoiceOrbRotation; radius: number } | null>(null);
  const [crowded, setCrowded] = useState(false);
  const crowdedRef = useRef(false);
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([]);
  const visibleKey = useRef("");
  const targetStyles = useRef(new Map<string, { width: string; height: string; transform: string; pointerEvents: string }>());
  const size = props.size ?? "pill", interactive = props.interactive ?? size === "expanded";

  useEffect(() => {
    const element = host.current, surface = canvas.current;
    if (!element || !surface) return;
    const context = surface.getContext("2d", { alpha: true });
    if (!context) {
      element.dataset.rendering = "fallback";
      const resizeFallback = () => element.style.setProperty("--voice-fallback-diameter",
        `${Math.min(element.clientWidth, element.clientHeight, bodyMeasure.current?.clientWidth || Infinity) * .104 * 2.6 * 2}px`);
      const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resizeFallback);
      observer?.observe(element); if (bodyMeasure.current) observer?.observe(bodyMeasure.current); resizeFallback();
      return () => { observer?.disconnect(); element.style.removeProperty("--voice-fallback-diameter"); };
    }
    const glass = size === "expanded" ? createVoiceGlass() : null;
    const shader = glass && { glass, rotation: new VoiceOrbRotation(), radius: 0 };
    shaderHover.current = shader;
    let shaderTime = 0, shaderAt = 0;
    let paletteSettings: Settings | undefined, paletteMode = "";
    let glassPalette: ReturnType<typeof resolveAtmospherePalette> | null = null;
    const systemLight = matchMedia("(prefers-color-scheme: light)");
    const motionPreference = matchMedia("(prefers-reduced-motion: reduce)"), contrastPreference = matchMedia("(prefers-contrast: more)");
    let reduced = motionPreference.matches, contrast = contrastPreference.matches, visible = true;
    let animation = 0, paintedAt = 0, paletteAt = -Infinity, palette = cssPalette(element);
    let width = 0, height = 0, bodySize = 0;
    const resize = () => { width = element.clientWidth; height = element.clientHeight; bodySize = bodyMeasure.current?.clientWidth ?? 0; };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
    observer?.observe(element); if (bodyMeasure.current) observer?.observe(bodyMeasure.current); resize();
    const intersection = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; });
    intersection?.observe(element);
    const preferences = () => {
      reduced = motionPreference.matches;
      contrast = contrastPreference.matches;
      if (shader && (reduced || contrast)) {
        shader.radius = 0;
        shader.rotation.stop();
      }
    };
    const abandonDrag = () => {
      motion.releaseDrag(true);
      gesture.current = undefined;
      shader?.rotation.stop();
      motion.point(0, 0, false);
    };
    window.addEventListener("blur", abandonDrag);
    motionPreference.addEventListener("change", preferences); contrastPreference.addEventListener("change", preferences);
    const draw = (now: number) => {
      animation = requestAnimationFrame(draw);
      if (!visible || document.hidden || !width || !height) { return; }
      if (now - paintedAt < 1000 / 30) return;
      paintedAt = now;
      const current = latest.current;
      const dt = shaderAt ? Math.min(.06, (now - shaderAt) / 1000) : 0;
      shaderAt = now;
      if (!reduced && !current.ambientPaused) shaderTime += dt;
      const settings=current.settings;
      const appearance = settings?.theme ?? element.closest<HTMLElement>("[data-theme]")?.dataset.theme;
      const mode = resolveThemeMode(appearance === "dark" || appearance === "light" ? appearance : "system", systemLight.matches);
      if(settings && (settings!==paletteSettings || mode!==paletteMode)){
        glassPalette=resolveAtmospherePalette(settings.homeAtmosphere,settings.homeAtmosphereTone,resolveThemePalette(settings,mode),settings.homeAtmosphereCustomColor,settings.homeAtmosphereCustomSecondaryColor);
        paletteSettings=settings;paletteMode=mode;
      }
      if (current.palette) palette = current.palette;
      else if (now - paletteAt > 250) { palette = cssPalette(element); paletteAt = now; }
      const scene = motion.advanceAt({ ...current, reducedMotion: reduced }, now);
      const dpr = Math.min(2, devicePixelRatio || 1), scale = Math.min(width, height), small = scale < 80, sidebar = scale < 30;
      if (surface.width !== Math.round(width * dpr) || surface.height !== Math.round(height * dpr)) { surface.width = Math.round(width * dpr); surface.height = Math.round(height * dpr); }
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      // Size the visible body before collision and viewport fitting so workers,
      // finding packets and click targets share the enlarged silhouette.
      const { centre, workers, companions, fit, positionScaleX, positionScaleY } = projectVoiceOrbs(scene, width, height, size === "expanded" ? 2.6 : 1,
        size === "expanded" ? bodySize || Math.min(width, height) : undefined);
      projection.current = { fit, x: positionScaleX, y: positionScaleY };
      if (shader) {
        shader.radius = glassPalette && !reduced && !contrast ? centre.radius : 0;
        if (shader.radius) shader.rotation.advance(dt);
      }
      const projected = new Map(workers.map(point => [point.slot, point]));
      const bodies = new Map(scene.workers.map(body => [body.id, body]));
      const ids = scene.workers.filter(body => projected.has(body.slot) && !body.returned).map(body => body.id);
      const key = JSON.stringify(ids);
      if (key !== visibleKey.current) { visibleKey.current = key; setVisibleIds(ids); }
      const live = current.status === "listening";
      function sphere(point: OrbCircle, rgb: RGB, stretch = 1, opacity = 1, glow = 0, focused = false, angle = 0, main = false) {
        if (!context) return;
        if (shader && glassPalette && !contrast && shader.glass.draw(context, point, glassPalette,
          shaderTime, shader.rotation, main, stretch, main ? 1 : opacity, glow, angle, current.settings?.voiceOrbStyle)) return;
        const { radius } = point;
        const pastel = mode === "light" ? lightGlassTint(rgb, 194, .82) : rgb;
        context.save(); context.translate(point.x, point.y); context.rotate(angle); context.scale(1 / Math.sqrt(stretch), Math.sqrt(stretch)); context.globalAlpha = main && mode === "light" ? .96 : opacity;
        // The approved gravity study has a softly illuminated volume even at
        // rest. Audio adds expression; it is not needed to reveal the material.
        if (!contrast) {
          const halo = context.createRadialGradient(0, 0, radius * .55, 0, 0, radius * 2.2);
          halo.addColorStop(0, color(pastel, (focused ? .33 : .10) + glow * .3)); halo.addColorStop(1, color(pastel, 0));
          context.fillStyle = halo; context.beginPath(); context.arc(0, 0, radius * 2.2, 0, Math.PI * 2); context.fill();
        }
        const body = context.createRadialGradient(-radius * .34, -radius * .42, radius * .03, radius * .26, radius * .38, radius * 1.42);
        if (mode === "light") {
          body.addColorStop(0, color(blend(pastel, white, .93)));
          body.addColorStop(.34, color(lightGlassTint(rgb, 222, .66)));
          body.addColorStop(.75, color(lightGlassTint(rgb, 207, .75)));
          body.addColorStop(1, color(pastel));
        } else {
          body.addColorStop(0, color(blend(rgb, palette.highlight, .82))); body.addColorStop(.24, color(blend(rgb, palette.highlight, .28)));
          body.addColorStop(.61, color(rgb)); body.addColorStop(.88, color(blend(rgb, palette.shadow, contrast ? .90 : .72))); body.addColorStop(1, color(palette.shadow));
        }
        context.fillStyle = body; context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill();
        if (mode === "light" && radius >= 4) {
          context.lineWidth = Math.max(1, radius * .045);
          context.strokeStyle = color(pastel);
          context.beginPath(); context.arc(0, 0, radius - context.lineWidth / 2, 0, Math.PI * 2); context.stroke();
        }
        if (!small) {
          context.rotate(-.4);
          const shine = context.createRadialGradient(-radius * .15, -radius * .59, 0, -radius * .15, -radius * .59, radius * .65);
          const shineColor = mode === "light" ? white : palette.highlight;
          shine.addColorStop(0, color(shineColor, .42)); shine.addColorStop(1, color(shineColor, 0));
          context.fillStyle = shine; context.beginPath(); context.ellipse(-radius * .12, -radius * .57, radius * .65, radius * .22, 0, 0, Math.PI * 2); context.fill();
        }
        context.restore();
      }
      const tint = (slot: number) => blend(palette.body, workerTint[slot % workerTint.length], [.34, .52, .45, .36, .35, .35][slot % workerTint.length]);
      const ring = (point: OrbCircle, rgb: RGB, slot: number) => {
        const radius = point.radius + (sidebar ? 1 : small ? 2 : 4);
        const ringColor = mode === "light" ? lightGlassTint(rgb, 194, .82) : rgb;
        const angle = reduced ? -.8 : scene.phase * 1.7 + slot * .65;
        context.save(); context.lineWidth = sidebar ? 1 : small ? 1.4 : 2; context.lineCap = "round";
        context.strokeStyle = color(ringColor, contrast ? .5 : .18);
        context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.stroke();
        context.strokeStyle = color(blend(ringColor, mode === "light" ? white : palette.highlight, .4), contrast ? 1 : .88);
        context.beginPath(); context.arc(point.x, point.y, radius, angle, angle + Math.PI * 1.2); context.stroke(); context.restore();
      };
      const working = new Set(current.jobs.filter(job => job.state === "running" && job.phase !== "queued" && job.phase !== "clarifying").map(job => job.id));
      companions.forEach(point => sphere(point, point.slot < 6 ? tint(point.slot) : blend(palette.body, palette.highlight, .25), 1, contrast ? .72 : .48));
      const drawWorker = (index: number) => {
        const body = scene.workers[index], point = projected.get(body.slot);
        if (!point) return;
        const ready = body.state === "completed";
        sphere(point, ready ? blend(tint(body.slot), palette.highlight, .14) : tint(body.slot), body.stretch,
          body.returned ? 1 : body.state === "failed" || body.state === "cancelled" ? .48 : live ? 1 : .55,
          body.finished * .55 + (ready ? .25 : 0), current.focusedJobId === body.id);
        if (!body.returned && (working.has(body.id) || current.thinking && current.focusedJobId === body.id && !current.activity.outputActive)) ring(point, tint(body.slot), body.slot);
      };
      scene.workers.forEach((body, index) => { if (body.y < 0) drawWorker(index); });
      for (const packet of scene.packets) {
        const start = workers.find(point => point.slot === packet.slot);
        if (!start) continue;
        const t = Math.min(1, packet.age / VOICE_ORB_UPDATE_FLIGHT_SECONDS), eased = t * t * (3 - 2 * t), distance = Math.max(1, Math.hypot(start.x - centre.x, start.y - centre.y));
        const endX = centre.x + (start.x - centre.x) / distance * centre.radius * .9, endY = centre.y + (start.y - centre.y) / distance * centre.radius * .9;
        sphere({ slot: packet.slot, x: start.x + (endX - start.x) * eased + Math.sin(t * Math.PI) * scale * .02, y: start.y + (endY - start.y) * eased, radius: Math.max(sidebar ? .5 : small ? .7 : 1.6, scale * .009) }, tint(packet.slot));
      }
      let mainColor = palette.body;
      if (scene.receivingSlot >= 0) mainColor = blend(mainColor, tint(scene.receivingSlot), scene.central.receiving * .28);
      if (current.muted) mainColor = blend(mainColor, palette.shadow, .3);
      sphere(centre, mainColor, scene.central.stretch, live ? 1 : .55, scene.central.receiving * .4 + scene.central.level * .2, !current.focusedJobId, scene.central.angle, true);
      if (!current.focusedJobId && (current.status === "connecting" || current.thinking && !current.activity.outputActive)) ring(centre, mainColor, -1);
      scene.workers.forEach((body, index) => { if (body.y >= 0) drawWorker(index); });
      let needsWorkList = workers.length < scene.workers.filter(body => !body.returned).length;
      targetStyles.current.clear();
      const positionButton = (button: HTMLButtonElement | null | undefined, point: OrbCircle, id?: string) => {
        const hit = Math.max(24, point.radius * 2 + 8);
        const overlap = point.slot !== -1 && scene.workers.length > 6 && [centre, ...workers].some(other => other.slot !== point.slot && Math.hypot(other.x - point.x, other.y - point.y) < (hit + Math.max(24, other.radius * 2 + 8)) / 2);
        // Tiny targets must not capture a neighbouring orb's click. Keyboard
        // access and the named work list remain available for every job.
        const style = { width: `${hit}px`, height: `${hit}px`, transform: `translate(${point.x - hit / 2}px, ${point.y - hit / 2}px)`, pointerEvents: overlap ? "none" : "auto" };
        if (id) targetStyles.current.set(id, style);
        if (button) Object.assign(button.style, style);
        needsWorkList ||= overlap;
      };
      positionButton(centreTarget.current, centre);
      ids.forEach(id => {
        const body = bodies.get(id), point = body && projected.get(body.slot);
        if (point && !body?.returned) positionButton(targets.current.get(id), point, id);
      });
      if (needsWorkList !== crowdedRef.current) { crowdedRef.current = needsWorkList; setCrowded(needsWorkList); }
      element.dataset.rendering = "ready";
      element.dataset.workerCount = String(scene.workers.length); element.dataset.visibleWorkerCount = String(workers.length);
      element.dataset.inputLevel = (current.activity.inputLevel ?? 0).toFixed(3); element.dataset.outputLevel = (current.activity.outputLevel ?? 0).toFixed(3);
      element.dataset.receiving = scene.central.receiving.toFixed(3);
      element.dataset.thinking = String(!!current.thinking || current.status === "connecting");
      element.dataset.workingRings = String(workers.filter(point => working.has(scene.workers.find(body => body.slot === point.slot)?.id ?? "")).length);
    };
    animation = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animation); glass?.dispose(); abandonDrag(); shaderHover.current = null; observer?.disconnect(); intersection?.disconnect(); motionPreference.removeEventListener("change", preferences); contrastPreference.removeEventListener("change", preferences); window.removeEventListener("blur", abandonDrag); };
  }, [motion, size]);

  const point = (event: ReactPointerEvent) => {
    const bounds = host.current!.getBoundingClientRect(), scale = Math.min(bounds.width, bounds.height);
    const x = (event.clientX - bounds.left - bounds.width / 2) / projection.current.x / projection.current.fit;
    const y = (event.clientY - bounds.top - bounds.height * .48) / projection.current.y / projection.current.fit;
    return size === "expanded" && scale >= 80 ? unprojectVoiceOrbPoint(x, y, 2.6) : { x, y };
  };
  const movePointer = (event: ReactPointerEvent) => {
    motion.point(0, 0, false);
    const drag = gesture.current;
    const hover = shaderHover.current;
    if (drag && drag.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) drag.moved = true;
      if (drag.moved) {
        const location = point(event);
        motion.moveDrag(location.x, location.y);
      }
    } else if (!drag && hover?.radius && event.pointerType === "mouse" && event.buttons === 0) {
      hover.rotation.point(event.clientX, event.clientY, event.timeStamp, hover.radius);
    } else {
      hover?.rotation.leave();
    }
  };
  const endDrag = (event: ReactPointerEvent, cancel: boolean) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    const previous = gesture.current; gesture.current = undefined;
    const id = motion.releaseDrag(cancel);
    if (id) { if (latest.current.focusedJobId === id) latest.current.onFocus(undefined); latest.current.onDismiss(id); }
    else if (!cancel && !previous.moved) {
      const job = latest.current.jobs.find(job => job.id === previous.id);
      if (job?.state === "completed" && job.result) latest.current.onFocus(job.id);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div ref={host} className={`voice-constellation voice-constellation--${size}`} data-muted={props.muted} data-status={props.status}
    role={interactive ? "group" : "img"} aria-label={props.status === "listening" ? props.muted ? "Voice on, microphone muted" : "Voice conversation" : props.status === "connecting" ? "Voice connecting" : "Voice disconnected"}
    onPointerMove={movePointer}
    onPointerLeave={() => { shaderHover.current?.rotation.leave(); motion.point(0, 0, false); }}>
    {size === "expanded" && <span ref={bodyMeasure} className="voice-constellation__body-size" aria-hidden="true" />}
    <canvas ref={canvas} aria-hidden="true" />
    {interactive && <>
      <button type="button" ref={centreTarget} className="voice-constellation__target" aria-label="Return to main voice conversation" aria-pressed={!props.focusedJobId}
        aria-busy={!props.focusedJobId && !!props.thinking} aria-description={props.focusedJobId ? "Main conversation paused; select to resume." : undefined}
        onPointerDown={event => event.preventDefault()} onClick={() => props.onFocus(undefined)} />
      {props.jobs.filter(job => visibleIds.includes(job.id)).map(job => <button type="button" key={job.id} ref={element => { if (element) { targets.current.set(job.id, element); Object.assign(element.style, targetStyles.current.get(job.id)); } else targets.current.delete(job.id); }}
        className="voice-constellation__target" aria-label={`${job.subject}. ${workerLabel(job)}`} title={job.subject}
        aria-disabled={job.state !== "completed" || !job.result} aria-pressed={props.focusedJobId === job.id}
        aria-busy={job.state === "running" && job.phase !== "queued" && job.phase !== "clarifying"}
        onPointerDown={event => { if (event.button !== 0 || !motion.beginDrag(job.id)) return; shaderHover.current?.rotation.leave(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { id: job.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; }}
        onPointerUp={event => endDrag(event, false)} onPointerCancel={event => endDrag(event, true)}
        onLostPointerCapture={event => endDrag(event, true)}
        onClick={event => { if (event.detail === 0 && job.state === "completed" && job.result) props.onFocus(job.id); }}
        onKeyDown={event => { if (event.key === "Escape") { motion.releaseDrag(true); gesture.current = undefined; } if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); motion.dismiss(job.id); if (props.focusedJobId === job.id) props.onFocus(undefined); props.onDismiss(job.id); } }} />)}
      {crowded && props.onShowConversation && <button type="button" className="voice-constellation__overflow" aria-label="Open voice conversation" onClick={props.onShowConversation}>Conversation</button>}
    </>}
  </div>;
}
