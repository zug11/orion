import type {
  ConceptStudioState,
} from "../types";

export const EMPTY_STUDIO: Readonly<ConceptStudioState> = {
  messages: [],
  cards: [],
  activeConceptId: null,
  selectedCardIds: [],
  view: "explore",
  zoom: 1,
  chatCollapsed: false,
  canvasCollapsed: false,
};

export function createEmptyStudio(): ConceptStudioState {
  return {
    ...EMPTY_STUDIO,
    messages: [],
    cards: [],
    selectedCardIds: [],
  };
}

export function normalizeStudio(
  studio: ConceptStudioState | undefined,
): ConceptStudioState {
  if (!studio) {
    return createEmptyStudio();
  }
  const cardIds = new Set(studio.cards.map((card) => card.id));
  return {
    ...studio,
    selectedCardIds: studio.selectedCardIds.filter((id) => cardIds.has(id)),
    zoom: clampStudioZoom(studio.zoom),
    canvasCollapsed:
      studio.chatCollapsed && studio.canvasCollapsed
        ? false
        : studio.canvasCollapsed,
  };
}

export function clampStudioZoom(zoom: number): number {
  return Math.min(1.3, Math.max(0.7, Math.round(zoom * 10) / 10));
}
