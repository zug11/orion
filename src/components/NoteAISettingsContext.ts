import { createContext } from "react";
import type { Settings } from "../types";

/** Both the main reader and writing windows use their active Space's connection. */
export const NoteAISettingsContext = createContext<Settings | undefined>(undefined);
