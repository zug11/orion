import { useEffect, useRef, useState } from "react";
import {
  atmosphereMotionValue,
  type AtmospherePalette,
} from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

interface ProceduralAtmosphereProps {
  fragmentSource: string;
  className: string;
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}

const vertexSource = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function ProceduralAtmosphere({
  palette,
  motion,
  fragmentSource,
  className,
}: ProceduralAtmosphereProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [contextGeneration, setContextGeneration] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.dataset.atmosphereState = "fallback";

    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!gl) return;

    const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const release = () => {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    if (!vertex || !fragment || !program || !buffer) {
      release();
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      release();
      return;
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      resolution: gl.getUniformLocation(program, "uResolution"),
      time: gl.getUniformLocation(program, "uTime"),
      pointer: gl.getUniformLocation(program, "uPointer"),
      touch: gl.getUniformLocation(program, "uTouch"),
    };
    for (const [name, hex] of [
      ["uPrimary", palette.primary],
      ["uSecondary", palette.secondary],
      ["uTertiary", palette.tertiary],
      ["uBackground", palette.background],
      ["uBackgroundSecondary", palette.backgroundSecondary],
    ]) {
      gl.uniform3f(
        gl.getUniformLocation(program, name),
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
      );
    }
    gl.uniform1f(gl.getUniformLocation(program, "uLight"), palette.isLight ? 1 : 0);

    canvas.setAttribute("aria-hidden", "true");
    container.append(canvas);
    container.dataset.atmosphereState = "ready";

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const interactionTarget = container.closest<HTMLElement>(".home-hero") ?? container;
    const speed = atmosphereMotionValue(motion);
    let reducedMotion = motionQuery.matches;
    let intersecting = true;
    let contextLost = false;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let pointerX = 0.69;
    let pointerY = 0.51;
    let targetX = pointerX;
    let targetY = pointerY;
    let touch = 0;
    let targetTouch = 0;
    let bounds = interactionTarget.getBoundingClientRect();

    const moving = () => speed > 0 && !reducedMotion;
    const visible = () => intersecting && !document.hidden && !contextLost;
    const render = () => {
      if (contextLost) return;
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, elapsed);
      gl.uniform2f(uniforms.pointer, pointerX, pointerY);
      gl.uniform1f(uniforms.touch, reducedMotion ? 0 : touch);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
    };
    const schedule = () => {
      if (!frame && moving() && visible()) frame = requestAnimationFrame(tick);
    };
    function tick(now: number) {
      frame = 0;
      if (!moving() || !visible()) return;
      if (!lastFrame || now - lastFrame >= 1000 / 30) {
        const delta = lastFrame ? Math.min(now - lastFrame, 80) / 1000 : 0;
        elapsed += delta * speed;
        const ease = 1 - Math.exp(-delta * 5);
        pointerX += (targetX - pointerX) * ease;
        pointerY += (targetY - pointerY) * ease;
        touch += (targetTouch - touch) * ease;
        render();
        lastFrame = now;
      }
      schedule();
    }
    const resize = () => {
      const size = container.getBoundingClientRect();
      bounds = interactionTarget.getBoundingClientRect();
      const width = Math.max(1, size.width);
      const height = Math.max(1, size.height);
      // Bound both pixel density and total fragment work on large displays.
      const scale = Math.min(window.devicePixelRatio || 1, 1.25,
        Math.sqrt(600_000 / (width * height)), 2048 / width, 2048 / height);
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (visible()) render();
    };
    const movePointer = (event: PointerEvent) => {
      if (reducedMotion || event.pointerType === "touch" || !bounds.width || !bounds.height) return;
      targetX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      targetY = Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height));
      targetTouch = 1;
      if (speed === 0) {
        pointerX = targetX;
        pointerY = targetY;
        touch = targetTouch;
        if (visible()) render();
      }
    };
    const enterPointer = (event: PointerEvent) => {
      bounds = interactionTarget.getBoundingClientRect();
      movePointer(event);
    };
    const leavePointer = () => {
      targetTouch = 0;
      if (speed === 0) {
        touch = 0;
        if (visible()) render();
      }
    };
    const visibilityChanged = () => {
      stop();
      if (visible()) render();
      schedule();
    };
    const motionChanged = () => {
      reducedMotion = motionQuery.matches;
      targetTouch = 0;
      touch = 0;
      stop();
      if (visible()) render();
      schedule();
    };
    const lostContext = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      stop();
      canvas.style.visibility = "hidden";
      container.dataset.atmosphereState = "fallback";
    };
    const restoredContext = () => setContextGeneration((generation) => generation + 1);
    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      visibilityChanged();
    });
    resizeObserver.observe(container);
    intersectionObserver.observe(container);
    interactionTarget.addEventListener("pointerenter", enterPointer);
    interactionTarget.addEventListener("pointermove", movePointer, { capture: true, passive: true });
    interactionTarget.addEventListener("pointerleave", leavePointer);
    document.addEventListener("visibilitychange", visibilityChanged);
    motionQuery.addEventListener("change", motionChanged);
    canvas.addEventListener("webglcontextlost", lostContext);
    canvas.addEventListener("webglcontextrestored", restoredContext);
    resize();
    schedule();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      interactionTarget.removeEventListener("pointerenter", enterPointer);
      interactionTarget.removeEventListener("pointermove", movePointer, { capture: true });
      interactionTarget.removeEventListener("pointerleave", leavePointer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      motionQuery.removeEventListener("change", motionChanged);
      canvas.removeEventListener("webglcontextlost", lostContext);
      canvas.removeEventListener("webglcontextrestored", restoredContext);
      canvas.remove();
      release();
    };
  }, [palette, motion, fragmentSource, contextGeneration]);

  return (
    <div
      ref={containerRef}
      className={`atmosphere-canvas ${className}`}
      data-atmosphere-state="fallback"
    >
      <i />
      <i />
      <i />
    </div>
  );
}
