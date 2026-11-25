import { createContext, useContext } from "react";

/** Window-local presentation only. The recording and editor keep their owners. */
export const DictationNavigationContext = createContext({
  background: false,
  blocked: false,
  noteTitle: "New note",
  onReturn: undefined as (() => void) | undefined,
});

export const useDictationNavigation = () => useContext(DictationNavigationContext);
