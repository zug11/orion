// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  autoResumeBackoffMs,
  formatProviderHealthConcern,
  isTransientProviderFailure,
  providerHealthSummary,
  recordProviderHealth,
  shouldAutoResume,
} from "./providerHealth";

const STORAGE_KEY = "orion:provider-health:v1";

describe("provider health memory", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  it("round-trips rolling outcomes into a per-provider summary", () => {
    recordProviderHealth({ provider: "openai", at: 1, ok: true, latencyMs: 100 });
    recordProviderHealth({ provider: "openai", at: 2, ok: true, latencyMs: 300 });
    recordProviderHealth({ provider: "openai", at: 3, ok: false, latencyMs: 200 });

    expect(providerHealthSummary("openai")).toEqual({
      recentFailures: 1,
      medianLatencyMs: 200,
    });
  });

  it("computes an even-count median across recorded latencies", () => {
    recordProviderHealth({ provider: "openai", at: 1, ok: true, latencyMs: 100 });
    recordProviderHealth({ provider: "openai", at: 2, ok: true, latencyMs: 400 });

    expect(providerHealthSummary("openai")?.medianLatencyMs).toBe(250);
  });

  it("keeps only the most recent 20 outcomes per provider", () => {
    for (let index = 0; index < 25; index += 1) {
      recordProviderHealth({
        provider: "openai",
        at: index,
        ok: index >= 5,
        latencyMs: index,
      });
    }

    expect(providerHealthSummary("openai")).toEqual({
      recentFailures: 0,
      medianLatencyMs: 14.5,
    });
  });

  it("keeps providers independent and reports no summary without data", () => {
    recordProviderHealth({ provider: "anthropic", at: 1, ok: false });

    expect(providerHealthSummary("anthropic")).toEqual({
      recentFailures: 1,
      medianLatencyMs: 0,
    });
    expect(providerHealthSummary("openai")).toBeUndefined();
  });

  it("treats corrupted JSON as a fresh state instead of throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not-json");

    expect(providerHealthSummary("openai")).toBeUndefined();
    expect(() =>
      recordProviderHealth({ provider: "openai", at: 1, ok: false }),
    ).not.toThrow();
    expect(providerHealthSummary("openai")).toEqual({
      recentFailures: 1,
      medianLatencyMs: 0,
    });
  });

  it("drops entries that no longer match the persisted shape", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        openai: "not-an-array",
        anthropic: [
          { provider: "anthropic", at: "later", ok: true },
          { provider: "anthropic", at: 7, ok: true, latencyMs: -4 },
          { provider: "anthropic", at: 9, ok: false },
        ],
      }),
    );

    expect(providerHealthSummary("openai")).toBeUndefined();
    expect(providerHealthSummary("anthropic")).toEqual({
      recentFailures: 1,
      medianLatencyMs: 0,
    });
  });
});

describe("provider health concern formatter", () => {
  it("stays silent without repeated recent failures", () => {
    expect(formatProviderHealthConcern("openai", undefined)).toBeUndefined();
    expect(
      formatProviderHealthConcern("openai", {
        recentFailures: 1,
        medianLatencyMs: 120,
      }),
    ).toBeUndefined();
  });

  it("names the provider and the repeated failure count", () => {
    expect(
      formatProviderHealthConcern("anthropic", {
        recentFailures: 3,
        medianLatencyMs: 120,
      }),
    ).toBe(
      "Anthropic has failed 3 of Orion's recent connection checks from this Mac.",
    );
  });
});

describe("shouldAutoResume", () => {
  const resumableCodes = [
    "provider-timeout",
    "provider-rate-limit",
    "provider-network",
    "provider-response",
    "validation",
    "coverage",
  ];
  const terminalCodes = [
    "cancelled",
    "space-changed",
    "import-time-limit",
    "provider-auth",
    "unknown",
  ];

  it.each(resumableCodes)(
    "allows two silent attempts for %s",
    (code) => {
      expect(shouldAutoResume(code, 0)).toBe(true);
      expect(shouldAutoResume(code, 1)).toBe(true);
      expect(shouldAutoResume(code, 2)).toBe(false);
      expect(shouldAutoResume(code, 3)).toBe(false);
    },
  );

  it.each(terminalCodes)("never auto-resumes %s", (code) => {
    expect(shouldAutoResume(code, 0)).toBe(false);
    expect(shouldAutoResume(code, 1)).toBe(false);
    expect(shouldAutoResume(code, 2)).toBe(false);
  });

  it("backs off two seconds, then eight", () => {
    expect(autoResumeBackoffMs(0)).toBe(2_000);
    expect(autoResumeBackoffMs(1)).toBe(8_000);
    expect(autoResumeBackoffMs(2)).toBe(8_000);
  });
});

describe("transient provider failures", () => {
  it.each(["HTTP 503", "HTTP 429", "service unavailable", "overloaded", "Bad gateway", "fetch failed", "socket hang up"])(
    "allows bounded recovery for %s", (message) => {
      expect(isTransientProviderFailure(message)).toBe(true);
    },
  );
  it.each(["HTTP 429: billing quota exceeded", "Invalid request schema: server error", "Model does not exist", "No API key; network unavailable"])(
    "does not disguise provider action as a transient failure: %s", (message) => {
      expect(isTransientProviderFailure(message)).toBe(false);
    },
  );
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
