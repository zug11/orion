export type EntityId = string;
export type ISODateString = string;

export type NoteKind =
  | "article"
  | "wiki"
  | "hub"
  | "person"
  | "place"
  | "project"
  | "idea";

export type NoteStatus = "draft" | "ready" | "archived";

export interface Note {
  id: EntityId;
  title: string;
  slug: string;
  summary: string;
  body: string;
  aliases: string[];
  tags: string[];
  /** @deprecated Hidden compatibility metadata; never expose as a user type. */
  kind: NoteKind;
  /** @deprecated Hidden compatibility metadata; new notes are always ready. */
  status: NoteStatus;
  conceptIds: EntityId[];
  sourceIds: EntityId[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /** Legacy navigation metadata; it must never change the stable sidebar order. */
  lastOpenedAt?: ISODateString;
  pinned?: boolean;
  color?: string;
}

export type SourceKind =
  | "manual"
  | "text"
  | "markdown"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "docx"
  | "image"
  | "audio"
  | "video"
  | "youtube";

export interface Source {
  id: EntityId;
  title: string;
  kind: SourceKind;
  importedAt: ISODateString;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  sourceUrl?: string;
  /** Optional user-authored emphasis for this import batch. */
  importGuidance?: string;
  text: string;
  noteIds: EntityId[];
}

/**
 * A concept represents a Space-scoped linkable phrase. `canonicalNoteId`
 * points at its primary wiki article; `noteIds` may also include contextual
 * notes that support the article or participate in an unresolved ambiguity.
 */
export interface Concept {
  id: EntityId;
  label: string;
  aliases: string[];
  description: string;
  noteIds: EntityId[];
  canonicalNoteId?: EntityId;
  color: string;
  icon?: string;
  autoLink: boolean;
  matchCase?: boolean;
}

export type RelationshipKind =
  | "mentions"
  | "related"
  | "supports"
  | "contrasts"
  | "part-of"
  | "inspired-by"
  | "named-after";

export interface Relationship {
  id: EntityId;
  fromNoteId: EntityId;
  toNoteId: EntityId;
  kind: RelationshipKind;
  label: string;
  strength: number;
  conceptId?: EntityId;
  sourceId?: EntityId;
  context?: string;
}

export type ImportDraftStatus =
  | "extracting"
  | "ready"
  | "organizing"
  | "complete"
  | "error";

export interface ImportDraft {
  id: EntityId;
  title: string;
  fileName: string;
  mimeType: string;
  format: SourceKind;
  byteSize: number;
  extractedText: string;
  createdAt: ISODateString;
  status: ImportDraftStatus;
  warnings: string[];
  error?: string;
  generatedNoteIds: EntityId[];
}

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type HomeAtmosphere =
  | "signal-decay"
  | "line-waves"
  | "field";

export type HomeAtmosphereTone =
  | "signature"
  | "violet"
  | "mint"
  | "gold";

export type HomeAtmosphereMotion = "still" | "calm" | "alive";

export type ThemeMode = "dark" | "light" | "system";
export type ThemePreset = "orion" | "tide" | "grove" | "ember";
export type ThemeAccent = "preset" | "iris" | "tide" | "moss" | "ember";
export type ThemeCanvasTone = "deep" | "balanced" | "airy";
export type ThemeSurfaceLift = "quiet" | "balanced" | "lifted";
export type ThemeTextWarmth = "cool" | "neutral" | "warm";
export type ThemeContrast = "soft" | "balanced" | "high";

export type SpeechVoice = "system" | "openai" | "elevenlabs";

export interface SavedElevenLabsVoice {
  name: string;
  voiceId: string;
}

export interface Settings {
  model: string;
  reasoningEffort: ReasoningEffort;
  apiKeyConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  /** Optional. Used only to speak notes and narrated decks. */
  elevenLabsApiKeyConfigured: boolean;
  /**
   * ElevenLabs voice ID from the user's library. Empty uses Orion's default
   * editorial voice. This is not a secret.
   */
  elevenLabsVoiceId: string;
  /** Named local voice presets. Optional in older vaults; never credentials. */
  elevenLabsVoices: SavedElevenLabsVoice[];
  /**
   * Who speaks Play and narrated decks. System works with no cloud key.
   * OpenAI and ElevenLabs require their respective keys.
   */
  speechVoice: SpeechVoice;
  /** Narrow icon rail. Text labels stay hidden while collapsed. */
  sidebarCollapsed: boolean;
  /** Opt-in: retry a failed knowledge request once on the other provider. */
  providerFailoverEnabled: boolean;
  autoLink: boolean;
  showHoverPreviews: boolean;
  includeExistingNotesInAIContext: boolean;
  organizationInstructions: string;
  whisperLanguage: string;
  theme: ThemeMode;
  themePreset: ThemePreset;
  themeAccent: ThemeAccent;
  themeAccentCustom: string;
  themeCanvasTone: ThemeCanvasTone;
  themeCanvasCustom: string;
  themeSurfaceLift: ThemeSurfaceLift;
  themeSurfaceCustom: string;
  themeTextWarmth: ThemeTextWarmth;
  themeContrast: ThemeContrast;
  homeAtmosphere: HomeAtmosphere;
  homeAtmosphereTone: HomeAtmosphereTone;
  homeAtmosphereMotion: HomeAtmosphereMotion;
}

export interface WorkspaceInfo {
  id: EntityId;
  name: string;
  description: string;
  createdAt: ISODateString;
}

export interface SpaceOverview {
  title: string;
  body: string;
  relatedNoteIds: EntityId[];
  generatedAt: ISODateString;
  stale: boolean;
}

export type SpaceDigestQuality = "complete" | "weak" | "fallback";

export interface SpaceNoteDigest {
  noteId: EntityId;
  noteVersion: string;
  title: string;
  aliases: string[];
  tags: string[];
  summary: string;
  headings: string[];
  wholeBodySketch: string;
  conceptLabels: string[];
  relationshipHints: string[];
  sourceIds: EntityId[];
  reference: boolean;
  bodyCharacters: number;
  contentFingerprint: string;
  quality: SpaceDigestQuality;
  qualityReason: string;
}

export interface SpaceKnowledgeBlueprint {
  id: EntityId;
  level: number;
  noteIds: EntityId[];
  childBlueprintIds: EntityId[];
  fingerprint: string;
  title: string;
  body: string;
  focusConcepts: string[];
  tensions: string[];
  openQuestions: string[];
  generatedAt: ISODateString;
  origin: "local" | "provider";
}

/**
 * Rebuildable Space-local semantic hierarchy. It is persisted so imports and
 * overview refreshes can inherit compact context without rereading every note.
 */
export interface SpaceKnowledgeIndex {
  schemaVersion: 1;
  snapshotFingerprint: string;
  digests: SpaceNoteDigest[];
  blueprints: SpaceKnowledgeBlueprint[];
  rootBlueprintId: EntityId | null;
  updatedAt: ISODateString;
  stale: boolean;
}

export type StudioCardKind =
  | "concept"
  | "claim"
  | "evidence"
  | "counterclaim"
  | "assumption"
  | "tension"
  | "question"
  | "synthesis"
  | "decision";

export type EpistemicStatus =
  | "observed"
  | "sourced"
  | "inferred"
  | "speculative"
  | "disputed"
  | "resolved";

export type StudioCardStage = "proposed" | "accepted" | "dismissed";
export type DialecticRole =
  | "thesis"
  | "antithesis"
  | "synthesis"
  | "question"
  | "none";

export interface StudioCard {
  id: EntityId;
  kind: StudioCardKind;
  title: string;
  body: string;
  epistemicStatus: EpistemicStatus;
  origin: "user" | "orion";
  stage: StudioCardStage;
  dialecticRole: DialecticRole;
  conceptIds: EntityId[];
  noteIds: EntityId[];
  sourceIds: EntityId[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface StudioMessage {
  id: EntityId;
  role: "user" | "assistant";
  content: string;
  cardIds: EntityId[];
  contextCardIds: EntityId[];
  /** Notes created from this reply, shown as permanent Space destinations. */
  createdNoteIds?: EntityId[];
  createdAt: ISODateString;
}

export interface ConceptStudioState {
  messages: StudioMessage[];
  cards: StudioCard[];
  activeConceptId: EntityId | null;
  selectedCardIds: EntityId[];
  view: "explore" | "dialectic";
  zoom: number;
  chatCollapsed: boolean;
  canvasCollapsed: boolean;
}

export interface AppSnapshot {
  schemaVersion: 1;
  workspace: WorkspaceInfo;
  notes: Note[];
  sources: Source[];
  concepts: Concept[];
  relationships: Relationship[];
  importDrafts: ImportDraft[];
  studio: ConceptStudioState;
  settings: Settings;
  spaceOverview?: SpaceOverview;
  spaceKnowledge?: SpaceKnowledgeIndex;
  activeNoteId: EntityId | null;
  updatedAt: ISODateString;
}

export interface OrionVault {
  schemaVersion: 2;
  spaces: AppSnapshot[];
  activeSpaceId: EntityId;
  updatedAt: ISODateString;
}

export interface ParsedImport {
  title: string;
  fileName: string;
  mimeType: string;
  format: SourceKind;
  byteSize: number;
  sourceUrl?: string;
  text: string;
  warnings: string[];
}

export interface RecognizedDocumentPage {
  pageNumber: number;
  text: string;
}

export interface RecognizedDocumentText {
  text: string;
  pageCount: number;
  pages: RecognizedDocumentPage[];
  warnings: string[];
}

export interface WhisperConfig {
  language?: string;
}

export interface TranscribedMedia {
  title: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  text: string;
  sourceUrl?: string;
  warnings: string[];
}

export interface TranscriptionSetupStatus {
  whisperAvailable: boolean;
  whisperVersion?: string;
  whisperModel: string;
  ytDlpAvailable: boolean;
  ytDlpVersion?: string;
  denoVersion?: string;
  message: string;
}

export interface AutoLinkTextSegment {
  type: "text";
  text: string;
  start: number;
  end: number;
}

export interface AutoLinkConceptSegment {
  type: "concept";
  text: string;
  start: number;
  end: number;
  conceptId: EntityId;
  targetNoteIds: EntityId[];
  ambiguous: boolean;
}

export type AutoLinkSegment = AutoLinkTextSegment | AutoLinkConceptSegment;

export interface WikiLinkResolution {
  raw: string;
  query: string;
  label: string;
  start: number;
  end: number;
  kind: "note" | "concept" | "missing";
  conceptId?: EntityId;
  noteIds: EntityId[];
  ambiguous: boolean;
}

export interface Backlink {
  noteId: EntityId;
  title: string;
  excerpt: string;
  matchedText: string;
  conceptId?: EntityId;
  kind: "explicit" | "mention" | "relationship";
}

export interface ConceptReference {
  noteId: EntityId;
  noteTitle: string;
  excerpt: string;
  matchedText: string;
  isTarget: boolean;
}

export type SearchResultKind = "note" | "concept" | "source";

export interface SearchResult {
  id: EntityId;
  kind: SearchResultKind;
  title: string;
  subtitle: string;
  excerpt: string;
  score: number;
  noteIds: EntityId[];
}

export interface ExistingNoteContext {
  id: EntityId;
  /** Frozen content identity for compact directory records. */
  version?: string;
  title: string;
  aliases: string[];
  summary: string;
  reference: boolean;
  tags?: string[];
  headings?: string[];
  conceptLabels?: string[];
  relationshipHints?: string[];
  semanticSketch?: string;
  bodyCharacters?: number;
  digestQuality?: "strong" | "weak";
  /**
   * Legacy compatibility only. Shared organizer context builders never attach
   * arbitrary note prose; full bodies require a separately authorized read.
   */
  body?: string;
}

export interface OrganizeContentRequest {
  content: string;
  sourceName?: string;
  spaceName?: string;
  spaceDescription?: string;
  existingNotes?: ExistingNoteContext[];
  model?: string;
  effort?: ReasoningEffort;
  /** Request-scoped feature rules, bounded separately from Space preferences. */
  taskInstructions?: string;
  organizationInstructions?: string;
  timeoutMs?: number;
}

export interface OrganizedLink {
  targetTitle: string;
  context: string;
}

export interface OrganizedNote {
  title: string;
  summary: string;
  body: string;
  tags: string[];
  aliases: string[];
  links: OrganizedLink[];
}

export interface OrganizedWikiArticle {
  title: string;
  summary: string;
  body: string;
  overview: string;
  spaceRelevance: string;
  sourceGroundedDetails: string[];
  uncertainties: string[];
  tags: string[];
  aliases: string[];
  links: OrganizedLink[];
}

export interface OrganizedConcept {
  label: string;
  aliases: string[];
  description: string;
  canonicalTitle: string;
  relatedTitles: string[];
}

export interface SuggestedConnection {
  fromTitle: string;
  toTitle: string;
  reason: string;
}

export interface OrganizeContentResult {
  notes: OrganizedNote[];
  wikiArticles: OrganizedWikiArticle[];
  concepts: OrganizedConcept[];
  suggestedConnections: SuggestedConnection[];
}

export interface ChatNoteContext {
  title: string;
  summary: string;
  body: string;
}

export interface ChatSourceContext {
  title: string;
  text: string;
}

export interface ChatConceptContext {
  label: string;
  description: string;
}

export interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  mode?: "chat" | "inline-writing";
  prompt: string;
  workspaceName: string;
  notes: ChatNoteContext[];
  sources: ChatSourceContext[];
  concepts: ChatConceptContext[];
  history: ChatHistoryItem[];
  /** Host-derived authorization for creation-only Chat note actions. */
  allowNoteActions?: boolean;
  model?: string;
  effort?: ReasoningEffort;
}

export interface ChatResult {
  reply: string;
  noteActions?: ChatNoteAction[];
}

export interface ChatNoteAction {
  title: string;
  summary: string;
  body: string;
  tags: string[];
  aliases: string[];
}

export interface ApiKeyStatus {
  configured: boolean;
}

export interface ApiKeyTestResult {
  valid: boolean;
  message: string;
}

export interface ExportMarkdownNote {
  title: string;
  body: string;
  tags?: string[];
}

export interface ExportMarkdownResult {
  exportedCount: number;
  directory: string;
  cancelled: boolean;
}

export interface ExportWebResult {
  path: string;
  cancelled: boolean;
}

export interface NoteImageAttachment {
  id: EntityId;
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** A portable Orion URL in desktop builds, or a data URL in browser preview. */
  src: string;
}

export interface GeneratedNoteImage {
  fileName: string;
  mimeType: "image/jpeg";
  byteSize: number;
  /** Transient provider output. Persist it only after the user accepts the preview. */
  base64Data: string;
}

export interface GeneratedSpeech {
  mimeType: "audio/mpeg";
  byteSize: number;
  base64Data: string;
}
