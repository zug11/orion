import { useRef, type ReactNode } from "react";
import { useNativeRulerGlass } from "./useNativeRulerGlass";

export function NativeFormattingDock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useNativeRulerGlass(ref);
  return <div ref={ref} className="editor-formatting-dock" data-native-editor-glass={active ? "true" : undefined}>{children}</div>;
}
