import { Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef, type HTMLAttributes } from "react";

const DEFAULT_FOCAL = [0.5, 0.5] as const;
const DEFAULT_ROTATION = [1, 0] as const;
const FRAME_INTERVAL = 1000 / 30;

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform vec2 uFocal;
uniform vec2 uRotation;
uniform float uStarSpeed;
uniform float uDensity;
uniform float uHueShift;
uniform float uSpeed;
uniform vec2 uMouse;
uniform float uGlowIntensity;
uniform float uSaturation;
uniform bool uMouseRepulsion;
uniform float uTwinkleIntensity;
uniform float uRotationSpeed;
uniform float uRepulsionStrength;
uniform float uMouseActiveFactor;
uniform bool uTransparent;

varying vec2 vUv;

#define NUM_LAYERS 4.0
#define STAR_COLOR_CUTOFF 0.2
#define MAT45 mat2(0.7071, -0.7071, 0.7071, 0.7071)
#define PERIOD 3.0

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float tri(float x) {
  return abs(fract(x) * 2.0 - 1.0);
}

float tris(float x) {
  float t = fract(x);
  return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0));
}

float trisn(float x) {
  float t = fract(x);
  return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0;
}

vec3 hsv2rgb(vec3 c) {
  vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
  return c.z * mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);
}

float star(vec2 uv, float flare) {
  float distanceToStar = max(length(uv), 0.001);
  float light = (0.05 * uGlowIntensity) / distanceToStar;
  float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  light += rays * flare * uGlowIntensity;
  uv *= MAT45;
  rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  light += rays * 0.3 * flare * uGlowIntensity;
  light *= smoothstep(1.0, 0.2, distanceToStar);
  return light;
}

vec3 starLayer(vec2 uv) {
  vec3 color = vec3(0.0);
  vec2 grid = fract(uv) - 0.5;
  vec2 id = floor(uv);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 starId = id + offset;
      float seed = hash21(starId);
      float size = fract(seed * 345.32);
      float gloss = tri(uStarSpeed / (PERIOD * seed + 1.0));
      float flare = smoothstep(0.9, 1.0, size) * gloss;

      float red = smoothstep(STAR_COLOR_CUTOFF, 1.0, hash21(starId + 1.0)) + STAR_COLOR_CUTOFF;
      float blue = smoothstep(STAR_COLOR_CUTOFF, 1.0, hash21(starId + 3.0)) + STAR_COLOR_CUTOFF;
      float green = min(red, blue) * seed;
      vec3 base = vec3(red, green, blue);

      float hue = atan(base.g - base.r, base.b - base.r) / 6.28318 + 0.5;
      hue = fract(hue + uHueShift / 360.0);
      float saturation = length(base - vec3(dot(base, vec3(0.299, 0.587, 0.114)))) * uSaturation;
      float value = max(max(base.r, base.g), base.b);
      base = hsv2rgb(vec3(hue, saturation, value));

      vec2 drift = vec2(
        tris(seed * 34.0 + uTime * uSpeed / 10.0),
        tris(seed * 38.0 + uTime * uSpeed / 30.0)
      ) - 0.5;

      float starLight = star(grid - offset - drift, flare);
      float twinkle = trisn(uTime * uSpeed + seed * 6.2831) * 0.5 + 1.0;
      starLight *= mix(1.0, twinkle, uTwinkleIntensity);
      color += starLight * size * base;
    }
  }

  return color;
}

void main() {
  vec2 focalPx = uFocal * uResolution.xy;
  vec2 uv = (vUv * uResolution.xy - focalPx) / uResolution.y;
  vec2 mouseNormal = uMouse - vec2(0.5);

  if (uMouseRepulsion) {
    vec2 mouseUv = (uMouse * uResolution.xy - focalPx) / uResolution.y;
    vec2 mouseDelta = uv - mouseUv;
    float mouseDistance = max(length(mouseDelta), 0.001);
    vec2 repulsion = (mouseDelta / mouseDistance) * (uRepulsionStrength / (mouseDistance + 0.1));
    uv += repulsion * 0.05 * uMouseActiveFactor;
  } else {
    uv += mouseNormal * 0.1 * uMouseActiveFactor;
  }

  float autoRotation = uTime * uRotationSpeed;
  mat2 rotation = mat2(
    cos(autoRotation),
    -sin(autoRotation),
    sin(autoRotation),
    cos(autoRotation)
  );
  uv = rotation * uv;
  uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * uv;

  vec3 color = vec3(0.0);
  for (float layer = 0.0; layer < 1.0; layer += 1.0 / NUM_LAYERS) {
    float depth = fract(layer + uStarSpeed * uSpeed);
    float scale = mix(20.0 * uDensity, 0.5 * uDensity, depth);
    float fade = depth * smoothstep(1.0, 0.9, depth);
    color += starLayer(uv * scale + layer * 453.32) * fade;
  }

  if (uTransparent) {
    float alpha = min(smoothstep(0.0, 0.3, length(color)), 1.0);
    gl_FragColor = vec4(color, alpha);
  } else {
    gl_FragColor = vec4(color, 1.0);
  }
}
`;

interface GalaxyProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  focal?: readonly [number, number];
  rotation?: readonly [number, number];
  starSpeed?: number;
  density?: number;
  hueShift?: number;
  disableAnimation?: boolean;
  speed?: number;
  mouseInteraction?: boolean;
  glowIntensity?: number;
  saturation?: number;
  mouseRepulsion?: boolean;
  twinkleIntensity?: number;
  rotationSpeed?: number;
  repulsionStrength?: number;
  transparent?: boolean;
}

export default function Galaxy({
  focal = DEFAULT_FOCAL,
  rotation = DEFAULT_ROTATION,
  starSpeed = 0.5,
  density = 1,
  hueShift = 140,
  disableAnimation = false,
  speed = 1,
  mouseInteraction = true,
  glowIntensity = 0.3,
  saturation = 0,
  mouseRepulsion = true,
  twinkleIntensity = 0.3,
  rotationSpeed = 0.1,
  repulsionStrength = 2,
  transparent = true,
  className = "",
  ...rest
}: GalaxyProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focalX = focal[0];
  const focalY = focal[1];
  const rotationX = rotation[0];
  const rotationY = rotation[1];

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !("WebGLRenderingContext" in window)) {
      return;
    }

    let disposed = false;
    let teardown: (() => void) | undefined;

    void Promise.resolve()
      .then(() => {
        if (disposed) {
          return;
        }

        const reduceMotionQuery = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        );
        let reduceMotion = disableAnimation || reduceMotionQuery.matches;
        let isIntersecting = true;
        let isDocumentVisible = !document.hidden;
        let animationFrame = 0;
        let lastRenderedAt = -FRAME_INTERVAL;
        const targetMouse = { x: 0.5, y: 0.5, active: 0 };
        const smoothMouse = { x: 0.5, y: 0.5, active: 0 };

        const renderer = new Renderer({
          alpha: transparent,
          antialias: false,
          depth: false,
          dpr: Math.min(window.devicePixelRatio || 1, 1.35),
          powerPreference: "low-power",
          premultipliedAlpha: false,
        });
        const { gl } = renderer;

        gl.clearColor(0, 0, 0, transparent ? 0 : 1);

        const geometry = new Triangle(gl);
        const program = new Program(gl, {
          vertex: vertexShader,
          fragment: fragmentShader,
          transparent,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            uTime: { value: 0 },
            uResolution: { value: new Float32Array([1, 1, 1]) },
            uFocal: { value: new Float32Array([focalX, focalY]) },
            uRotation: {
              value: new Float32Array([rotationX, rotationY]),
            },
            uStarSpeed: { value: 0 },
            uDensity: { value: density },
            uHueShift: { value: hueShift },
            uSpeed: { value: speed },
            uMouse: { value: new Float32Array([0.5, 0.5]) },
            uGlowIntensity: { value: glowIntensity },
            uSaturation: { value: saturation },
            uMouseRepulsion: { value: mouseRepulsion },
            uTwinkleIntensity: { value: twinkleIntensity },
            uRotationSpeed: { value: rotationSpeed },
            uRepulsionStrength: { value: repulsionStrength },
            uMouseActiveFactor: { value: 0 },
            uTransparent: { value: transparent },
          },
        });
        const mesh = new Mesh(gl, { geometry, program });
        const canvas = gl.canvas;
        canvas.setAttribute("aria-hidden", "true");
        container.append(canvas);
        container.dataset.galaxyState = "ready";

        const render = (time: number) => {
          program.uniforms.uTime.value = time * 0.001;
          program.uniforms.uStarSpeed.value =
            (time * 0.001 * starSpeed) / 10;

          smoothMouse.x += (targetMouse.x - smoothMouse.x) * 0.055;
          smoothMouse.y += (targetMouse.y - smoothMouse.y) * 0.055;
          smoothMouse.active +=
            (targetMouse.active - smoothMouse.active) * 0.055;

          program.uniforms.uMouse.value[0] = smoothMouse.x;
          program.uniforms.uMouse.value[1] = smoothMouse.y;
          program.uniforms.uMouseActiveFactor.value = smoothMouse.active;
          renderer.render({ scene: mesh });
        };

        const requestNextFrame = () => {
          if (
            animationFrame === 0 &&
            !reduceMotion &&
            isIntersecting &&
            isDocumentVisible
          ) {
            animationFrame = requestAnimationFrame(drawFrame);
          }
        };

        const drawFrame = (time: number) => {
          animationFrame = 0;
          if (time - lastRenderedAt >= FRAME_INTERVAL) {
            render(time);
            lastRenderedAt = time;
          }
          requestNextFrame();
        };

        const resize = () => {
          const bounds = container.getBoundingClientRect();
          renderer.setSize(
            Math.max(1, Math.round(bounds.width)),
            Math.max(1, Math.round(bounds.height)),
          );
          const resolution = program.uniforms.uResolution
            .value as Float32Array;
          resolution[0] = canvas.width;
          resolution[1] = canvas.height;
          resolution[2] = canvas.width / canvas.height;
          render(performance.now());
        };

        const resizeObserver =
          typeof ResizeObserver === "undefined"
            ? undefined
            : new ResizeObserver(resize);
        resizeObserver?.observe(container);
        if (!resizeObserver) {
          window.addEventListener("resize", resize);
        }

        const intersectionObserver =
          typeof IntersectionObserver === "undefined"
            ? undefined
            : new IntersectionObserver(([entry]) => {
                isIntersecting = entry?.isIntersecting ?? true;
                if (!isIntersecting && animationFrame !== 0) {
                  cancelAnimationFrame(animationFrame);
                  animationFrame = 0;
                }
                requestNextFrame();
              });
        intersectionObserver?.observe(container);

        const interactionTarget = container.parentElement ?? container;
        const handlePointerMove = (event: PointerEvent) => {
          if (!mouseInteraction || reduceMotion || event.pointerType === "touch") {
            return;
          }
          const bounds = interactionTarget.getBoundingClientRect();
          targetMouse.x = Math.min(
            1,
            Math.max(0, (event.clientX - bounds.left) / bounds.width),
          );
          targetMouse.y = 1 - Math.min(
            1,
            Math.max(0, (event.clientY - bounds.top) / bounds.height),
          );
          targetMouse.active = 1;
        };
        const handlePointerLeave = () => {
          targetMouse.active = 0;
        };
        const handleVisibilityChange = () => {
          isDocumentVisible = !document.hidden;
          if (!isDocumentVisible && animationFrame !== 0) {
            cancelAnimationFrame(animationFrame);
            animationFrame = 0;
          }
          requestNextFrame();
        };
        const handleMotionPreference = (
          event: MediaQueryListEvent,
        ) => {
          reduceMotion = disableAnimation || event.matches;
          if (reduceMotion) {
            if (animationFrame !== 0) {
              cancelAnimationFrame(animationFrame);
              animationFrame = 0;
            }
            targetMouse.active = 0;
            render(0);
          } else {
            requestNextFrame();
          }
        };

        if (mouseInteraction) {
          interactionTarget.addEventListener(
            "pointermove",
            handlePointerMove,
            { passive: true },
          );
          interactionTarget.addEventListener(
            "pointerleave",
            handlePointerLeave,
          );
        }
        document.addEventListener("visibilitychange", handleVisibilityChange);
        reduceMotionQuery.addEventListener("change", handleMotionPreference);

        resize();
        if (reduceMotion) {
          render(0);
        } else {
          requestNextFrame();
        }

        teardown = () => {
          if (animationFrame !== 0) {
            cancelAnimationFrame(animationFrame);
          }
          resizeObserver?.disconnect();
          intersectionObserver?.disconnect();
          if (!resizeObserver) {
            window.removeEventListener("resize", resize);
          }
          if (mouseInteraction) {
            interactionTarget.removeEventListener(
              "pointermove",
              handlePointerMove,
            );
            interactionTarget.removeEventListener(
              "pointerleave",
              handlePointerLeave,
            );
          }
          document.removeEventListener(
            "visibilitychange",
            handleVisibilityChange,
          );
          reduceMotionQuery.removeEventListener(
            "change",
            handleMotionPreference,
          );
          geometry.remove();
          program.remove();
          if (canvas.isConnected) {
            canvas.remove();
          }
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        };
      })
      .catch(() => {
        if (!disposed && container.isConnected) {
          container.dataset.galaxyState = "fallback";
        }
      });

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [
    density,
    disableAnimation,
    focalX,
    focalY,
    glowIntensity,
    hueShift,
    mouseInteraction,
    mouseRepulsion,
    repulsionStrength,
    rotationSpeed,
    rotationX,
    rotationY,
    saturation,
    speed,
    starSpeed,
    transparent,
    twinkleIntensity,
  ]);

  return (
    <div
      ref={containerRef}
      className={`galaxy ${className}`.trim()}
      {...rest}
    />
  );
}
