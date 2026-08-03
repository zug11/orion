import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

type BorderGlowElement = "button" | "div";

interface BorderGlowProps {
  as?: BorderGlowElement;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  edgeSensitivity?: number;
  glowColor?: string;
  secondaryColor?: string;
  tertiaryColor?: string;
  glowIntensity?: number;
  animated?: boolean;
  type?: "button" | "reset" | "submit";
  onClick?: MouseEventHandler<HTMLElement>;
}

export default function BorderGlow({
  as,
  children,
  className,
  edgeSensitivity = 64,
  glowColor = "#a8b3ff",
  secondaryColor = "#7bc9b0",
  tertiaryColor = "#d8b675",
  glowIntensity = 0.78,
  animated = false,
  style,
  type = "button",
  onClick,
}: BorderGlowProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const animationFrameRef = useRef(0);

  const updateGlow = useCallback(() => {
    animationFrameRef.current = 0;
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }

    const bounds = surface.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) {
      return;
    }

    const x = Math.min(bounds.width, Math.max(0, pointerRef.current.x));
    const y = Math.min(bounds.height, Math.max(0, pointerRef.current.y));
    const horizontal = x - bounds.width / 2;
    const vertical = y - bounds.height / 2;
    const angle =
      (Math.atan2(vertical, horizontal) * 180) / Math.PI + 90;
    const edgeDistance = Math.min(
      x,
      y,
      bounds.width - x,
      bounds.height - y,
    );
    const proximity = Math.max(
      0,
      Math.min(1, (edgeSensitivity - edgeDistance) / edgeSensitivity),
    );
    const strength = Math.min(
      1,
      (0.16 + proximity * 0.84) * glowIntensity,
    );

    surface.style.setProperty("--border-glow-angle", `${angle}deg`);
    surface.style.setProperty(
      "--border-glow-strength",
      strength.toFixed(3),
    );
  }, [edgeSensitivity, glowIntensity]);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") {
        return;
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      pointerRef.current.x = event.clientX - bounds.left;
      pointerRef.current.y = event.clientY - bounds.top;
      if (animationFrameRef.current === 0) {
        animationFrameRef.current = requestAnimationFrame(updateGlow);
      }
    },
    [updateGlow],
  );

  const clearGlow = useCallback(() => {
    if (animationFrameRef.current !== 0) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
    surfaceRef.current?.style.setProperty("--border-glow-strength", "0");
  }, []);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== 0) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  const glowStyle = {
    ...style,
    borderColor: "transparent",
    "--border-glow-color": glowColor,
    "--border-glow-color-secondary": secondaryColor,
    "--border-glow-color-tertiary": tertiaryColor,
  } as CSSProperties;
  const glowClassName = clsx(
    "border-glow",
    animated && "border-glow--animated",
    className,
  );
  const content = (
    <>
      {children}
      <span className="border-glow__edge" aria-hidden="true" />
      <span className="border-glow__aura" aria-hidden="true" />
    </>
  );
  const setSurfaceRef = (node: HTMLElement | null) => {
    surfaceRef.current = node;
  };

  if (as === "button") {
    return (
      <button
        ref={setSurfaceRef}
        type={type}
        className={glowClassName}
        style={glowStyle}
        onClick={onClick}
        onPointerMove={handlePointerMove}
        onPointerLeave={clearGlow}
        onPointerCancel={clearGlow}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      ref={setSurfaceRef}
      className={glowClassName}
      style={glowStyle}
      onClick={onClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={clearGlow}
      onPointerCancel={clearGlow}
    >
      {content}
    </div>
  );
}
