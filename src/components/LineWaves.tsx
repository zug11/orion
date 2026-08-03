import { Renderer, Program, Mesh, Triangle } from 'ogl';
import { useEffect, useRef } from 'react';
import { atmosphereMotionValue } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Adapted for Orion from the MIT + Commons Clause React Bits Line Waves effect.
interface LineWavesProps {
  speed?: number;
  innerLineCount?: number;
  outerLineCount?: number;
  warpIntensity?: number;
  rotation?: number;
  edgeFadeWidth?: number;
  colorCycleSpeed?: number;
  brightness?: number;
  color1?: string;
  color2?: string;
  color3?: string;
  enableMouseInteraction?: boolean;
  mouseInfluence?: number;
  motion?: HomeAtmosphereMotion;
}

function hexToVec3(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform float uSpeed;
uniform float uInnerLines;
uniform float uOuterLines;
uniform float uWarpIntensity;
uniform float uRotation;
uniform float uEdgeFadeWidth;
uniform float uColorCycleSpeed;
uniform float uBrightness;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec2 uMouse;
uniform float uMouseInfluence;
uniform bool uEnableMouse;

#define HALF_PI 1.5707963

float hashF(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

float smoothNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hashF(i), hashF(i + 1.0), u);
}

float displaceA(float coord, float t) {
  float result = sin(coord * 2.123) * 0.2;
  result += sin(coord * 3.234 + t * 4.345) * 0.1;
  result += sin(coord * 0.589 + t * 0.934) * 0.5;
  return result;
}

float displaceB(float coord, float t) {
  float result = sin(coord * 1.345) * 0.3;
  result += sin(coord * 2.734 + t * 3.345) * 0.2;
  result += sin(coord * 0.189 + t * 0.934) * 0.3;
  return result;
}

vec2 rotate2D(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

void main() {
  vec2 coords = gl_FragCoord.xy / uResolution.xy;
  coords = coords * 2.0 - 1.0;
  coords = rotate2D(coords, uRotation);

  float halfT = uTime * uSpeed * 0.5;
  float fullT = uTime * uSpeed;

  float mouseWarp = 0.0;
  if (uEnableMouse) {
    vec2 mPos = rotate2D(uMouse * 2.0 - 1.0, uRotation);
    float mDist = length(coords - mPos);
    mouseWarp = uMouseInfluence * exp(-mDist * mDist * 4.0);
  }

  float warpAx = coords.x + displaceA(coords.y, halfT) * uWarpIntensity + mouseWarp;
  float warpAy = coords.y - displaceA(coords.x * cos(fullT) * 1.235, halfT) * uWarpIntensity;
  float warpBx = coords.x + displaceB(coords.y, halfT) * uWarpIntensity + mouseWarp;
  float warpBy = coords.y - displaceB(coords.x * sin(fullT) * 1.235, halfT) * uWarpIntensity;

  vec2 fieldA = vec2(warpAx, warpAy);
  vec2 fieldB = vec2(warpBx, warpBy);
  vec2 blended = mix(fieldA, fieldB, mix(fieldA, fieldB, 0.5));

  float fadeTop = smoothstep(uEdgeFadeWidth, uEdgeFadeWidth + 0.4, blended.y);
  float fadeBottom = smoothstep(-uEdgeFadeWidth, -(uEdgeFadeWidth + 0.4), blended.y);
  float vMask = 1.0 - max(fadeTop, fadeBottom);

  float tileCount = mix(uOuterLines, uInnerLines, vMask);
  float scaledY = blended.y * tileCount;
  float nY = smoothNoise(abs(scaledY));

  float ridge = pow(
    step(abs(nY - blended.x) * 2.0, HALF_PI) * cos(2.0 * (nY - blended.x)),
    5.0
  );

  float lines = 0.0;
  for (float i = 1.0; i < 3.0; i += 1.0) {
    lines += pow(max(fract(scaledY), fract(-scaledY)), i * 2.0);
  }

  float pattern = vMask * lines;

  float cycleT = fullT * uColorCycleSpeed;
  float rChannel = (pattern + lines * ridge) * (cos(blended.y + cycleT * 0.234) * 0.5 + 1.0);
  float gChannel = (pattern + vMask * ridge) * (sin(blended.x + cycleT * 1.745) * 0.5 + 1.0);
  float bChannel = (pattern + lines * ridge) * (cos(blended.x + cycleT * 0.534) * 0.5 + 1.0);

  vec3 col = (rChannel * uColor1 + gChannel * uColor2 + bChannel * uColor3) * uBrightness;
  float alpha = clamp(length(col), 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}
`;

export default function LineWaves({
  speed,
  innerLineCount = 28,
  outerLineCount = 34,
  warpIntensity = 0.74,
  rotation = -12,
  edgeFadeWidth = 0.24,
  colorCycleSpeed = 0.18,
  brightness = 0.11,
  color1 = "#7bc9b0",
  color2 = "#8fa1e8",
  color3 = "#a8b3ff",
  enableMouseInteraction = true,
  mouseInfluence = 0.72,
  motion = "calm",
}: LineWavesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedSpeed =
    speed ?? atmosphereMotionValue(motion) * 0.32;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !("WebGLRenderingContext" in window)) {
      return;
    }
    const renderer = new Renderer({
      alpha: true,
      antialias: false,
      dpr: 1,
      powerPreference: "low-power",
      premultipliedAlpha: false,
    });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const interactionTarget =
      container.closest<HTMLElement>(".home-hero") ?? container;
    let interactionBounds = interactionTarget.getBoundingClientRect();
    let reduceMotion = motionQuery.matches;
    let isIntersecting = true;
    let isDocumentVisible = !document.hidden;
    let animationFrame = 0;
    let lastRenderedAt = -1000 / 30;
    const currentMouse = [0.5, 0.5];
    let targetMouse = [0.5, 0.5];

    function handlePointerMove(event: PointerEvent) {
      if (
        event.pointerType === "touch" ||
        interactionBounds.width === 0 ||
        interactionBounds.height === 0
      ) {
        return;
      }
      targetMouse = [
        (event.clientX - interactionBounds.left) / interactionBounds.width,
        1 -
          (event.clientY - interactionBounds.top) / interactionBounds.height,
      ];
    }

    function handlePointerEnter() {
      interactionBounds = interactionTarget.getBoundingClientRect();
    }

    function handlePointerLeave() {
      targetMouse = [0.5, 0.5];
    }

    function resize() {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds) {
        return;
      }
      interactionBounds = interactionTarget.getBoundingClientRect();
      renderer.setSize(
        Math.max(1, Math.round(bounds.width)),
        Math.max(1, Math.round(bounds.height)),
      );
      program.uniforms.uResolution.value = [
        gl.canvas.width,
        gl.canvas.height,
        gl.canvas.width / gl.canvas.height,
      ];
    }

    const geometry = new Triangle(gl);
    const rotationRad = (rotation * Math.PI) / 180;
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [1, 1, 1] },
        uSpeed: { value: resolvedSpeed },
        uInnerLines: { value: innerLineCount },
        uOuterLines: { value: outerLineCount },
        uWarpIntensity: { value: warpIntensity },
        uRotation: { value: rotationRad },
        uEdgeFadeWidth: { value: edgeFadeWidth },
        uColorCycleSpeed: { value: colorCycleSpeed },
        uBrightness: { value: brightness },
        uColor1: { value: hexToVec3(color1) },
        uColor2: { value: hexToVec3(color2) },
        uColor3: { value: hexToVec3(color3) },
        uMouse: { value: new Float32Array([0.5, 0.5]) },
        uMouseInfluence: { value: mouseInfluence },
        uEnableMouse: { value: enableMouseInteraction },
      },
      transparent: true,
    });

    const mesh = new Mesh(gl, { geometry, program });
    const canvas = gl.canvas;
    canvas.setAttribute("aria-hidden", "true");
    container.append(canvas);
    container.dataset.atmosphereState = "ready";

    function render(time: number) {
      program.uniforms.uTime.value = reduceMotion ? 0 : time * 0.001;
      if (enableMouseInteraction && !reduceMotion) {
        currentMouse[0] += 0.06 * (targetMouse[0] - currentMouse[0]);
        currentMouse[1] += 0.06 * (targetMouse[1] - currentMouse[1]);
      } else {
        currentMouse[0] = 0.5;
        currentMouse[1] = 0.5;
      }
      program.uniforms.uMouse.value[0] = currentMouse[0];
      program.uniforms.uMouse.value[1] = currentMouse[1];
      renderer.render({ scene: mesh });
    }

    function requestNextFrame() {
      if (
        animationFrame === 0 &&
        !reduceMotion &&
        isIntersecting &&
        isDocumentVisible
      ) {
        animationFrame = requestAnimationFrame(drawFrame);
      }
    }

    function drawFrame(time: number) {
      animationFrame = 0;
      if (time - lastRenderedAt >= 1000 / 30) {
        render(time);
        lastRenderedAt = time;
      }
      requestNextFrame();
    }

    function handleVisibilityChange() {
      isDocumentVisible = !document.hidden;
      if (!isDocumentVisible && animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      requestNextFrame();
    }

    function handleMotionPreference(event: MediaQueryListEvent) {
      reduceMotion = event.matches;
      if (reduceMotion && animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      render(reduceMotion ? 0 : performance.now());
      requestNextFrame();
    }

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isIntersecting = entry?.isIntersecting ?? true;
      if (!isIntersecting && animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      requestNextFrame();
    });
    resizeObserver.observe(container);
    intersectionObserver.observe(container);
    interactionTarget.addEventListener("pointerenter", handlePointerEnter);
    interactionTarget.addEventListener("pointermove", handlePointerMove, {
      capture: true,
      passive: true,
    });
    interactionTarget.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    motionQuery.addEventListener("change", handleMotionPreference);

    resize();
    render(0);
    requestNextFrame();

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
      interactionTarget.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
      interactionTarget.removeEventListener(
        "pointerleave",
        handlePointerLeave,
      );
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
      motionQuery.removeEventListener("change", handleMotionPreference);
      geometry.remove();
      program.remove();
      canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [
    brightness,
    color1,
    color2,
    color3,
    colorCycleSpeed,
    edgeFadeWidth,
    enableMouseInteraction,
    innerLineCount,
    mouseInfluence,
    outerLineCount,
    rotation,
    resolvedSpeed,
    warpIntensity,
  ]);

  return (
    <div
      ref={containerRef}
      className="atmosphere-canvas line-waves"
    />
  );
}
