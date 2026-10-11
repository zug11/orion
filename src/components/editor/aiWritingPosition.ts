import type { AIWritingControlPosition } from "../AIWritingControls";

interface RectLike {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export function resolveAIWritingSelectionPosition(input: {
  workspace: RectLike;
  toolbarBottom: number;
  start: RectLike;
  end: RectLike;
}): AIWritingControlPosition {
  const { workspace, toolbarBottom, start, end } = input;
  const startVisible =
    start.top >= workspace.top + 44 && start.top <= workspace.bottom - 40;
  const anchor = startVisible ? start : end;
  const availableAbove =
    anchor.top - Math.max(workspace.top + 44, toolbarBottom);
  const placement: "above" | "below" =
    availableAbove < 250 ? "below" : "above";
  const top =
    placement === "below"
      ? clamp(
          end.bottom + 9,
          Math.max(workspace.top + 58, toolbarBottom + 8),
          workspace.bottom - 52,
        )
      : clamp(
          anchor.top - 9,
          workspace.top + 58,
          workspace.bottom - 32,
        );

  const halfWidth = Math.min(176, Math.max(0, (workspace.right - workspace.left - 24) / 2));
  return {
    left: clamp(
      Math.abs(start.top - end.top) < 4 ? (start.left + end.right) / 2 : anchor.left + halfWidth,
      workspace.left + halfWidth + (halfWidth < 176 ? 12 : 0),
      workspace.right - halfWidth - (halfWidth < 176 ? 12 : 0),
    ),
    top,
    visible: true,
    placement,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
