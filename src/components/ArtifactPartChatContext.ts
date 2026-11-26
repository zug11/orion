import { createContext } from "react";

export const ArtifactPartChatContext = createContext<((draft: string) => void) | undefined>(undefined);
export const ArtworkReviewNoticeContext = createContext<((message: string) => void) | undefined>(undefined);
export interface ArtifactQuestionDraft { spaceId: string; threadId: string; noteId: string; text: string }
