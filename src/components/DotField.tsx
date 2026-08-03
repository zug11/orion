import { useEffect, useRef, type HTMLAttributes } from "react";
import {
  atmosphereMotionValue,
  type AtmospherePalette,
} from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

interface Dot {
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
}

interface DotFieldProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}

const DOT_SPACING = 23;
const POINTER_RADIUS = 190;
const RESPONSE_MS = 48;

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export default function DotField({
  palette,
  motion,
  className = "",
  ...rest
}: DotFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      container.dataset.atmosphereState = "fallback";
      return;
    }

    const reduceMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let reduceMotion = reduceMotionQuery.matches;
    let isIntersecting = true;
    let isDocumentVisible = !document.hidden;
    let animationFrame = 0;
    let lastFrameAt = performance.now();
    let bounds = container.getBoundingClientRect();
    let dots: Dot[] = [];
    let gradient: CanvasGradient | string = hexToRgba(
      palette.primary,
      0.42,
    );
    const motionValue = atmosphereMotionValue(motion);
    const pointerStrength = 28 + motionValue * 32;
    const responseMs =
      motion === "still" ? 90 : motion === "alive" ? 34 : RESPONSE_MS;
    const pointer = { x: -10_000, y: -10_000, active: false };

    canvas.setAttribute("aria-hidden", "true");
    container.append(canvas);
    container.dataset.atmosphereState = "ready";

    const buildDots = () => {
      bounds = container.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const columns = Math.ceil(width / DOT_SPACING) + 1;
      const rows = Math.ceil(height / DOT_SPACING) + 1;
      const offsetX = (width - (columns - 1) * DOT_SPACING) / 2;
      const offsetY = (height - (rows - 1) * DOT_SPACING) / 2;
      dots = [];
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const anchorX = offsetX + column * DOT_SPACING;
          const anchorY = offsetY + row * DOT_SPACING;
          dots.push({
            anchorX,
            anchorY,
            x: anchorX,
            y: anchorY,
          });
        }
      }
      const nextGradient = context.createLinearGradient(
        width * 0.25,
        0,
        width,
        height,
      );
      nextGradient.addColorStop(0, hexToRgba(palette.primary, 0.48));
      nextGradient.addColorStop(0.56, hexToRgba(palette.secondary, 0.39));
      nextGradient.addColorStop(1, hexToRgba(palette.tertiary, 0.34));
      gradient = nextGradient;
    };

    const draw = (time: number) => {
      const width = canvas.width / Math.min(window.devicePixelRatio || 1, 1.25);
      const height =
        canvas.height / Math.min(window.devicePixelRatio || 1, 1.25);
      const delta = Math.min(50, Math.max(1, time - lastFrameAt));
      lastFrameAt = time;
      const response = reduceMotion
        ? 1
        : 1 - Math.exp(-delta / responseMs);
      const radiusSquared = POINTER_RADIUS * POINTER_RADIUS;
      let unsettled = false;

      context.clearRect(0, 0, width, height);
      context.fillStyle = gradient;
      context.beginPath();
      for (const dot of dots) {
        let targetX = dot.anchorX;
        let targetY = dot.anchorY;
        if (pointer.active && !reduceMotion) {
          const dx = pointer.x - dot.anchorX;
          const dy = pointer.y - dot.anchorY;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < radiusSquared && distanceSquared > 0.01) {
            const distance = Math.sqrt(distanceSquared);
            const influence = 1 - distance / POINTER_RADIUS;
            const push = influence * influence * pointerStrength;
            targetX -= (dx / distance) * push;
            targetY -= (dy / distance) * push;
          }
        }
        dot.x += (targetX - dot.x) * response;
        dot.y += (targetY - dot.y) * response;
        if (
          Math.abs(targetX - dot.x) > 0.04 ||
          Math.abs(targetY - dot.y) > 0.04
        ) {
          unsettled = true;
        }
        context.moveTo(dot.x + 1.05, dot.y);
        context.arc(dot.x, dot.y, 1.05, 0, Math.PI * 2);
      }
      context.fill();

      if (
        unsettled &&
        !reduceMotion &&
        isIntersecting &&
        isDocumentVisible
      ) {
        animationFrame = requestAnimationFrame(draw);
      } else {
        animationFrame = 0;
      }
    };

    const requestDraw = () => {
      if (
        animationFrame === 0 &&
        isIntersecting &&
        isDocumentVisible
      ) {
        animationFrame = requestAnimationFrame(draw);
      }
    };
    const resize = () => {
      buildDots();
      draw(performance.now());
    };
    const interactionTarget =
      container.closest<HTMLElement>(".home-hero") ?? container;
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || reduceMotion) {
        return;
      }
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = true;
      requestDraw();
    };
    const updatePointer = (event: PointerEvent) => {
      bounds = interactionTarget.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = true;
      requestDraw();
    };
    const handlePointerEnter = (event: PointerEvent) => {
      if (event.pointerType === "touch" || reduceMotion) {
        return;
      }
      updatePointer(event);
    };
    const handlePointerLeave = () => {
      pointer.active = false;
      requestDraw();
    };
    const handleVisibilityChange = () => {
      isDocumentVisible = !document.hidden;
      if (!isDocumentVisible && animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else {
        requestDraw();
      }
    };
    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reduceMotion = event.matches;
      pointer.active = false;
      if (animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      draw(performance.now());
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isIntersecting = entry?.isIntersecting ?? true;
      if (!isIntersecting && animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else {
        requestDraw();
      }
    });
    intersectionObserver.observe(container);
    interactionTarget.addEventListener("pointerenter", handlePointerEnter);
    interactionTarget.addEventListener("pointermove", handlePointerMove, {
      capture: true,
      passive: true,
    });
    interactionTarget.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    reduceMotionQuery.addEventListener("change", handleMotionPreference);

    resize();

    return () => {
      if (animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
      }
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      interactionTarget.removeEventListener(
        "pointerenter",
        handlePointerEnter,
      );
      interactionTarget.removeEventListener(
        "pointermove",
        handlePointerMove,
        { capture: true },
      );
      interactionTarget.removeEventListener(
        "pointerleave",
        handlePointerLeave,
      );
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
      reduceMotionQuery.removeEventListener(
        "change",
        handleMotionPreference,
      );
      canvas.remove();
    };
  }, [motion, palette]);

  return (
    <div
      ref={containerRef}
      className={`atmosphere-canvas field ${className}`.trim()}
      {...rest}
    />
  );
}
