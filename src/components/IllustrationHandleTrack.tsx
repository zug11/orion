import { useRef, type PointerEvent } from "react";
import type { DrawingPoint } from "../lib/artifactIllustration";
import { handlePoint, handlePosition, type DrawingHandle } from "../lib/illustrationHandles";

function drawingPoint(event: PointerEvent<SVGGElement>): DrawingPoint | undefined {
  const svg = event.currentTarget.ownerSVGElement;
  const matrix = svg?.getScreenCTM();
  if (!svg || !matrix) return;
  const point = svg.createSVGPoint();
  point.x = event.clientX; point.y = event.clientY;
  const local = point.matrixTransform(matrix.inverse());
  if (Number.isFinite(local.x) && Number.isFinite(local.y)) return [local.x, local.y];
}

export function IllustrationHandleTrack({handle, value, radius, color, onChange}: {
  handle: DrawingHandle; value: number; radius: number; color: string; onChange: (position: number) => void;
}) {
  const active = useRef<{id: number; offset: DrawingPoint} | undefined>(undefined);
  const {track} = handle;
  const [x, y] = handlePoint(track, value);
  const end = handlePoint(track, 1);
  const distance = "pivot" in track ? Math.hypot(track.from[0] - track.pivot[0], track.from[1] - track.pivot[1]) : 0;
  const rail = "to" in track ? "L " + end.join(" ") :
    ["A", distance, distance, 0, Number(Math.abs(track.turn) > 180), Number(track.turn > 0), ...end].join(" ");
  const d = "M " + track.from.join(" ") + " " + rail;
  const update = (point: DrawingPoint, offset: DrawingPoint) => onChange(handlePosition(track,
    [point[0] - offset[0], point[1] - offset[1]], value));
  const finish = (event: PointerEvent<SVGGElement>) => {
    if (active.current?.id !== event.pointerId) return;
    active.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <g data-drawing-handle={handle.label} aria-hidden="true" color={color}
    onPointerDown={event => {
      if (active.current || event.button !== 0 || event.isPrimary === false) return;
      const point = drawingPoint(event);
      if (!point) return;
      event.preventDefault(); event.stopPropagation();
      const grip = (event.target as Element).closest("[data-handle-grip]");
      const offset: DrawingPoint = grip ? [point[0] - x, point[1] - y] : [0, 0];
      active.current = {id: event.pointerId, offset};
      event.currentTarget.setPointerCapture(event.pointerId);
      if (grip) onChange(value);
      else update(point, offset);
    }}
    onPointerMove={event => {
      const drag = active.current;
      if (!drag || drag.id !== event.pointerId) return;
      const point = drawingPoint(event);
      if (point) update(point, drag.offset);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onClick={event => event.stopPropagation()}>
    <path d={d} className="artifact-illustration__rail" fill="none" vectorEffect="non-scaling-stroke" />
    <path d={d} stroke="transparent" strokeWidth="22" vectorEffect="non-scaling-stroke" fill="none" />
    <g data-handle-grip="" transform={`translate(${x} ${y})`}>
      <circle r={radius} className="artifact-illustration__grip" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle r={radius * .31} fill="currentColor" />
      <circle r={radius} stroke="transparent" strokeWidth="22" vectorEffect="non-scaling-stroke" fill="transparent" />
    </g>
  </g>;
}
