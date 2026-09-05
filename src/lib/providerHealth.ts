import type { AIProvider } from "./ai";

const PROVIDER_HEALTH_STORAGE_KEY = "orion:provider-health:v1";
const MAX_ENTRIES_PER_PROVIDER = 20;
const REPEATED_FAILURE_THRESHOLD = 2;

export interface ProviderHealthEntry {
  provider: AIProvider;
  at: number;
  ok: boolean;
  latencyMs?: number;
}

export interface ProviderHealthSummary {
  recentFailures: number;
  medianLatencyMs: number;
}

type ProviderHealthState = Record<string, ProviderHealthEntry[]>;

/**
 * Records one provider outcome in the rolling local health memory. Storage is
 * best-effort observability: corruption or an unavailable store must never
 * interrupt the import flow, so every failure path degrades to a no-op.
 */
export function recordProviderHealth(entry: ProviderHealthEntry): void {
  const storage = healthStorage();
  if (!storage) return;
  const state = loadHealthState(storage);
  const entries = state[entry.provider] ?? [];
  entries.push({
    provider: entry.provider,
    at: entry.at,
    ok: entry.ok,
    ...(entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs }),
  });
  state[entry.provider] = entries.slice(-MAX_ENTRIES_PER_PROVIDER);
  try {
    storage.setItem(PROVIDER_HEALTH_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked store loses telemetry, never the import.
  }
}

export function providerHealthSummary(
  provider: AIProvider,
): ProviderHealthSummary | undefined {
  const storage = healthStorage();
  if (!storage) return undefined;
  const entries = loadHealthState(storage)[provider];
  if (!entries || entries.length === 0) return undefined;
  const latencies = entries.flatMap((entry) =>
    entry.latencyMs === undefined ? [] : [entry.latencyMs],
  );
  return {
    recentFailures: entries.filter((entry) => !entry.ok).length,
    medianLatencyMs: median(latencies),
  };
}

/**
 * One optional sentence, in Orion's voice, appended to a preflight failure
 * when the rolling memory shows the provider has been failing repeatedly.
 */
export function formatProviderHealthConcern(
  provider: AIProvider,
  summary: ProviderHealthSummary | undefined,
): string | undefined {
  if (!summary || summary.recentFailures < REPEATED_FAILURE_THRESHOLD) {
    return undefined;
  }
  return `${providerDisplayName(provider)} has failed ${summary.recentFailures} of Orion's recent connection checks from this Mac.`;
}

export function providerDisplayName(provider: AIProvider): string {
  return provider === "anthropic" ? "Anthropic" : "OpenAI";
}

/** Retry transport/pacing failures, never credentials or a rejected request. */
export function isTransientProviderFailure(message: string): boolean {
  if (
    /unauthori[sz]ed|forbidden|rejected.*key|no.*api key|permission|billing|quota|insufficient|payment|invalid.*schema|model.*(?:not found|does not exist|access)/i.test(message)
  ) {
    return false;
  }
  return /could not reach|network|connection (?:reset|refused|lost)|offline|dns|temporarily unavailable|service unavailable|overloaded|server error|bad gateway|gateway timeout|failed to fetch|fetch failed|socket hang up|HTTP (?:408|429|500|502|503|504|529)\b|rate (?:or usage )?limits?|too many requests/i.test(message);
}

const AUTO_RESUMABLE_IMPORT_CODES = new Set([
  "provider-timeout",
  "provider-rate-limit",
  "provider-network",
  "provider-response",
  "validation",
  "coverage",
]);

/**
 * Gate for the import flow's silent recovery: only transient, checkpoint-safe
 * failure codes earn an automatic resume, and only twice per batch. The direct
 * time limit has a separate one-time planned recovery; cancellation and stale
 * Space snapshots must never be resumed.
 */
export function shouldAutoResume(code: string, attempt: number): boolean {
  return attempt < 2 && AUTO_RESUMABLE_IMPORT_CODES.has(code);
}

export function autoResumeBackoffMs(attempt: number): number {
  return attempt === 0 ? 2_000 : 8_000;
}

function loadHealthState(storage: Storage): ProviderHealthState {
  let raw: string | null;
  try {
    raw = storage.getItem(PROVIDER_HEALTH_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const state: ProviderHealthState = {};
  for (const [provider, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const entries = value.filter(isProviderHealthEntry);
    if (entries.length > 0) {
      state[provider] = entries.slice(-MAX_ENTRIES_PER_PROVIDER);
    }
  }
  return state;
}

function isProviderHealthEntry(value: unknown): value is ProviderHealthEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.provider === "openai" || entry.provider === "anthropic") &&
    typeof entry.at === "number" &&
    Number.isFinite(entry.at) &&
    typeof entry.ok === "boolean" &&
    (entry.latencyMs === undefined ||
      (typeof entry.latencyMs === "number" &&
        Number.isFinite(entry.latencyMs) &&
        entry.latencyMs >= 0))
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function healthStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
