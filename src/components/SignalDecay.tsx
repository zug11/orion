import { Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef } from "react";
import {
  atmosphereMotionValue,
  type AtmospherePalette,
} from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Adapted for Orion from Paul Bakaus's MIT-licensed Radiant Signal Decay.
interface SignalDecayProps {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}

function hexToVec3(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

const vertexShader = `
attribute vec2 position;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec2 uResolution;
uniform float uSignalSpeed;
uniform float uDecayIntensity;
uniform vec2 uMouse;
uniform float uMouseAmount;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform vec3 uTertiary;
uniform vec3 uBright;
uniform vec3 uMuted;
uniform vec3 uBackground;
uniform vec3 uBackgroundSecondary;
uniform float uLightMode;

#define TAU 6.28318530
#define NUM_TRACKS 9

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float result = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    result += amplitude * valueNoise(p);
    p *= 2.07;
    amplitude *= 0.5;
  }
  return result;
}

float softClip(float value, float amount) {
  float strength = mix(1.0, 4.2, amount);
  float shifted = strength * value;
  float absolute = abs(shifted);
  return shifted / (1.0 + absolute + 0.28 * shifted * shifted);
}

float hardClip(float value, float amount) {
  float threshold = mix(1.0, 0.24, amount);
  return clamp(value, -threshold, threshold) / max(threshold, 0.001);
}

float bitCrush(float value, float amount) {
  float levels = mix(96.0, 4.0, amount * amount);
  return floor(value * levels + 0.5) / levels;
}

float degradedWave(
  float x,
  float time,
  float frequency,
  float phaseOffset,
  float amplitude,
  float decay
) {
  float phase =
    x * frequency * TAU +
    phaseOffset +
    time * uSignalSpeed * (1.25 + frequency * 0.18);

  float phaseDistortion = decay * decay * 1.65;
  phase +=
    phaseDistortion * sin(phase * 1.7 + time * 0.3) +
    phaseDistortion * 0.35 * sin(phase * 3.1);

  float fm = decay * 1.05;
  float wave = sin(phase + fm * sin(phase * 2.13 + time * 0.5));
  wave *=
    1.0 -
    decay *
      0.3 *
      (0.5 + 0.5 * sin(x * 2.5 + time * uSignalSpeed * 1.3 + phaseOffset));

  float softAmount = smoothstep(0.08, 0.35, decay);
  wave = mix(wave, softClip(wave, softAmount), softAmount);
  float hardAmount = smoothstep(0.28, 0.6, decay);
  wave = mix(wave, hardClip(wave, hardAmount), hardAmount);
  float crushAmount = smoothstep(0.5, 0.84, decay);
  wave = mix(wave, bitCrush(wave, crushAmount), crushAmount);

  float noiseAmount = smoothstep(0.42, 0.92, decay);
  float noise =
    (hash(vec2(x * 48.0 + phaseOffset, time * 6.0 + frequency)) - 0.5) *
    2.0;
  wave = mix(wave, wave + noise * 0.34, noiseAmount);
  return wave * amplitude;
}

float compositeWave(float x, float time, float decay) {
  float wave = 0.0;
  wave += degradedWave(x, time, 1.0, 0.0, 0.38, decay);
  wave += degradedWave(x, time, 1.618, 1.047, 0.27, decay);
  wave += degradedWave(x, time, 2.414, 2.094, 0.19, decay);
  wave += degradedWave(x, time, 3.302, 3.665, 0.13, decay);
  return wave;
}

float signalLine(float distance, float width, float spread) {
  float core = smoothstep(width, 0.0, abs(distance));
  float softness = exp(-abs(distance) / max(spread, 0.0001)) * 0.16;
  return core + softness;
}

float glitch(float y, float time, float decay) {
  float amount = smoothstep(0.38, 0.78, decay);
  float first =
    step(0.97, hash(vec2(floor(y * 54.0), floor(time * 3.2))));
  float second =
    step(0.95, hash(vec2(floor(y * 27.0), floor(time * 4.8 + 77.0))));
  float offset =
    first * (hash(vec2(y * 11.0, time * 2.7)) - 0.5) * 0.075;
  offset +=
    second * (hash(vec2(y * 23.0, time * 4.2 + 50.0)) - 0.5) * 0.038;
  return offset * amount;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  float yFromTop = 1.0 - uv.y;

  vec2 pointerDelta = (uv - uMouse) * vec2(aspect, 1.0);
  float pointerPressure =
    exp(-dot(pointerDelta, pointerDelta) * 8.0) * uMouseAmount;
  float boundaryShift =
    ((1.0 - uMouse.y) - 0.5) * 0.42 * uMouseAmount;
  float decay = clamp(
    pow(max(yFromTop + boundaryShift, 0.0), 0.78) * uDecayIntensity +
      pointerPressure * 0.13,
    0.0,
    1.0
  );

  float glitchOffset = glitch(yFromTop, uTime, decay);
  vec3 color = vec3(0.0);
  float signalPresence = 0.0;
  float trackHeight = 1.0 / float(NUM_TRACKS);

  for (int i = 0; i < NUM_TRACKS; i++) {
    float track = float(i);
    float center = (track + 0.5) * trackHeight;
    float trackFromTop = 1.0 - center;
    float trackPointerDistance = abs(center - uMouse.y);
    float trackPressure =
      exp(-trackPointerDistance * trackPointerDistance * 22.0) *
      uMouseAmount;
    float trackDecay = clamp(
      pow(max(trackFromTop + boundaryShift * 0.72, 0.0), 0.78) *
        uDecayIntensity +
        trackPressure * 0.1,
      0.0,
      1.0
    );

    float trackOffset = track * 0.391;
    float x =
      (uv.x + glitchOffset) * aspect +
      trackOffset +
      pointerPressure * pointerDelta.x * 0.22;
    float wave = compositeWave(x, uTime + track * 0.17, trackDecay);
    float amplitude =
      trackHeight * 0.36 * (1.0 + trackDecay * 0.52);
    float waveY = center + wave * amplitude;
    float distance = uv.y - waveY;
    float lineWidth = mix(0.0007, 0.0022, trackDecay);
    float spread = mix(0.0023, 0.009, trackDecay * trackDecay);

    float fragmentAmount = smoothstep(0.52, 0.88, trackDecay);
    float dashFrequency = mix(24.0, 76.0, fragmentAmount);
    float dashSeed = hash(
      vec2(
        floor(x * dashFrequency),
        track + floor(uTime * max(uSignalSpeed, 0.01) * 4.0)
      )
    );
    float dashMask = mix(1.0, step(0.3, dashSeed), fragmentAmount);
    float line = signalLine(distance, lineWidth, spread) * dashMask;

    vec3 trackColor =
      mix(uPrimary, uSecondary, smoothstep(0.16, 0.48, trackDecay));
    trackColor =
      mix(trackColor, uTertiary, smoothstep(0.42, 0.68, trackDecay));
    trackColor =
      mix(trackColor, uBright, smoothstep(0.54, 0.84, trackDecay));
    color += trackColor * line;
    signalPresence = max(signalPresence, clamp(line, 0.0, 1.0));
  }

  float noiseFloor =
    smoothstep(0.67, 1.0, yFromTop + boundaryShift * 0.5) *
    uDecayIntensity;
  if (noiseFloor > 0.001) {
    float broadNoise =
      fbm(gl_FragCoord.xy * 0.011 + vec2(uTime * 0.28, 0.0));
    float scanNoise =
      valueNoise(
        gl_FragCoord.xy * vec2(0.19, 0.008) +
          vec2(uTime * 1.6, 0.0)
      );
    float band =
      valueNoise(vec2(uTime * 2.2, gl_FragCoord.y * 0.07));
    float noise = broadNoise * 0.56 + scanNoise * 0.29 + band * 0.15;
    float noisePresence = noise * noiseFloor * 0.38;
    color += uMuted * noisePresence;
    signalPresence = max(signalPresence, noisePresence);
  }

  vec3 background = mix(
    uBackground,
    uBackgroundSecondary,
    yFromTop
  );
  if (uLightMode > 0.5) {
    vec3 signalColor = clamp(
      color / max(signalPresence, 0.001),
      0.0,
      1.0
    );
    color = mix(background, signalColor, clamp(signalPresence, 0.0, 1.0));
  } else {
    color += background;
  }

  vec2 vignettePoint = uv - 0.5;
  float vignette =
    1.0 -
    dot(
      vignettePoint * vec2(0.86, 0.54),
      vignettePoint * vec2(0.86, 0.54)
    ) *
      1.2;
  float vignetteStrength = clamp(0.5 + 0.5 * vignette, 0.0, 1.0);
  if (uLightMode > 0.5) {
    color = mix(uBackground, color, mix(0.82, 1.0, vignetteStrength));
  } else {
    color *= vignetteStrength;
  }

  float grain =
    (hash(gl_FragCoord.xy + fract(uTime * 0.05) * 137.0) - 0.5) *
    0.012;
  color += grain;
  color = clamp(color, 0.0, 1.0);
  color = color * color * (3.0 - 2.0 * color);

  gl_FragColor = vec4(color, 1.0);
}
`;

export default function SignalDecay({
  palette,
  motion,
}: SignalDecayProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !("WebGLRenderingContext" in window)) {
      return;
    }

    const renderer = new Renderer({
      alpha: false,
      antialias: false,
      dpr: Math.min(window.devicePixelRatio || 1, 1.2),
      powerPreference: "low-power",
    });
    const gl = renderer.gl;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const interactionTarget =
      container.closest<HTMLElement>(".home-hero") ?? container;
    const geometry = new Triangle(gl);
    const motionValue = atmosphereMotionValue(motion);
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new Float32Array([1, 1]) },
        uSignalSpeed: { value: motionValue * 0.5 },
        uDecayIntensity: { value: 0.78 + motionValue * 0.2 },
        uMouse: { value: new Float32Array([0.72, 0.5]) },
        uMouseAmount: { value: 0 },
        uPrimary: { value: hexToVec3(palette.primary) },
        uSecondary: { value: hexToVec3(palette.secondary) },
        uTertiary: { value: hexToVec3(palette.tertiary) },
        uBright: { value: hexToVec3(palette.bright) },
        uMuted: { value: hexToVec3(palette.muted) },
        uBackground: { value: hexToVec3(palette.background) },
        uBackgroundSecondary: {
          value: hexToVec3(palette.backgroundSecondary),
        },
        uLightMode: { value: palette.isLight ? 1 : 0 },
      },
    });
    const mesh = new Mesh(gl, { geometry, program });
    const canvas = gl.canvas;
    const currentMouse = [0.72, 0.5];
    const targetMouse = [0.72, 0.5];
    let targetMouseAmount = 0;
    let reducedMotion = motionQuery.matches;
    let isIntersecting = true;
    let isDocumentVisible = !document.hidden;
    let bounds = interactionTarget.getBoundingClientRect();
    let animationFrame = 0;
    let lastRenderedAt = -1000 / 30;

    canvas.setAttribute("aria-hidden", "true");
    container.append(canvas);
    container.dataset.atmosphereState = "ready";

    const render = (time: number) => {
      const isStill = motion === "still";
      if (isStill) {
        currentMouse[0] = targetMouse[0];
        currentMouse[1] = targetMouse[1];
        program.uniforms.uMouseAmount.value = targetMouseAmount;
      } else {
        currentMouse[0] += (targetMouse[0] - currentMouse[0]) * 0.09;
        currentMouse[1] += (targetMouse[1] - currentMouse[1]) * 0.09;
        program.uniforms.uMouseAmount.value +=
          (targetMouseAmount - program.uniforms.uMouseAmount.value) * 0.09;
      }
      program.uniforms.uMouse.value[0] = currentMouse[0];
      program.uniforms.uMouse.value[1] = currentMouse[1];
      program.uniforms.uTime.value =
        reducedMotion || isStill ? 0 : time * 0.001;
      renderer.render({ scene: mesh });
    };

    const requestNextFrame = () => {
      if (
        animationFrame === 0 &&
        !reducedMotion &&
        motion !== "still" &&
        isIntersecting &&
        isDocumentVisible
      ) {
        animationFrame = requestAnimationFrame(drawFrame);
      }
    };

    function drawFrame(time: number) {
      animationFrame = 0;
      if (time - lastRenderedAt >= 1000 / 30) {
        render(time);
        lastRenderedAt = time;
      }
      requestNextFrame();
    }

    const resize = () => {
      const containerBounds = container.getBoundingClientRect();
      bounds = interactionTarget.getBoundingClientRect();
      renderer.setSize(
        Math.max(1, Math.round(containerBounds.width)),
        Math.max(1, Math.round(containerBounds.height)),
      );
      program.uniforms.uResolution.value[0] = gl.canvas.width;
      program.uniforms.uResolution.value[1] = gl.canvas.height;
      render(performance.now());
    };

    const updatePointer = (event: PointerEvent) => {
      if (
        event.pointerType === "touch" ||
        bounds.width === 0 ||
        bounds.height === 0 ||
        reducedMotion
      ) {
        return;
      }
      targetMouse[0] =
        (event.clientX - bounds.left) / bounds.width;
      targetMouse[1] =
        1 - (event.clientY - bounds.top) / bounds.height;
      targetMouseAmount = 1;
      if (motion === "still") {
        render(performance.now());
      }
    };

    const handlePointerEnter = (event: PointerEvent) => {
      bounds = interactionTarget.getBoundingClientRect();
      updatePointer(event);
    };
    const handlePointerLeave = () => {
      targetMouseAmount = 0;
      if (motion === "still") {
        render(performance.now());
      }
    };
    const handleVisibilityChange = () => {
      isDocumentVisible = !document.hidden;
      if (!isDocumentVisible && animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      requestNextFrame();
    };
    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      targetMouseAmount = 0;
      if (reducedMotion && animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      render(0);
      requestNextFrame();
    };

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
    interactionTarget.addEventListener("pointermove", updatePointer, {
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
      interactionTarget.removeEventListener("pointermove", updatePointer, {
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
  }, [motion, palette]);

  return (
    <div
      ref={containerRef}
      className="atmosphere-canvas signal-decay"
    />
  );
}
