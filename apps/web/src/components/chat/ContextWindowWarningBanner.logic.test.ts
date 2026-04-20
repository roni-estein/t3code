import { assert, describe, it } from "vitest";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";

import {
  CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT,
  deriveContextWindowWarning,
} from "./ContextWindowWarningBanner.logic";

/**
 * Build a `ContextWindowSnapshot` with safe defaults so each test only has
 * to specify the fields it actually cares about. The real snapshot has a
 * dozen nullable token-count fields that this module ignores; defaulting
 * them here keeps the tests focused on the decision we're covering.
 */
function snapshot(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 0,
    totalProcessedTokens: null,
    maxTokens: null,
    remainingTokens: null,
    usedPercentage: null,
    remainingPercentage: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveContextWindowWarning", () => {
  it("returns null when no usage snapshot is available", () => {
    assert.equal(deriveContextWindowWarning(null), null);
  });

  it("returns null when the provider auto-compacts (redundant nag)", () => {
    const result = deriveContextWindowWarning(
      snapshot({
        usedPercentage: 92,
        maxTokens: 200_000,
        remainingTokens: 16_000,
        compactsAutomatically: true,
      }),
    );
    assert.equal(result, null);
  });

  it("returns null when usedPercentage is unknown (maxTokens not reported)", () => {
    const result = deriveContextWindowWarning(
      snapshot({
        usedPercentage: null,
        maxTokens: null,
        remainingTokens: null,
      }),
    );
    assert.equal(result, null);
  });

  it("returns null when below the warning threshold", () => {
    const result = deriveContextWindowWarning(
      snapshot({
        usedPercentage: CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT - 1,
        maxTokens: 200_000,
        remainingTokens: 52_000,
      }),
    );
    assert.equal(result, null);
  });

  it("surfaces a view-model when exactly at the threshold", () => {
    const result = deriveContextWindowWarning(
      snapshot({
        usedPercentage: CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT,
        maxTokens: 200_000,
        remainingTokens: 50_000,
      }),
    );
    assert.deepEqual(result, {
      usedPercentageRounded: 75,
      remainingTokens: 50_000,
    });
  });

  it("rounds the percentage so we never show a noisy decimal", () => {
    const result = deriveContextWindowWarning(
      snapshot({
        usedPercentage: 87.6,
        maxTokens: 200_000,
        remainingTokens: 24_800,
      }),
    );
    assert.deepEqual(result, {
      usedPercentageRounded: 88,
      remainingTokens: 24_800,
    });
  });

  it("plumbs a null remainingTokens through (maxTokens unknown but usedPercentage somehow reported)", () => {
    // Defensive: the snapshot deriver won't emit this in practice, but the
    // banner should not crash if it does. Treat remainingTokens as optional.
    const result = deriveContextWindowWarning(
      snapshot({
        usedPercentage: 80,
        remainingTokens: null,
      }),
    );
    assert.deepEqual(result, {
      usedPercentageRounded: 80,
      remainingTokens: null,
    });
  });

  it("surfaces the banner at 99% (just under saturation)", () => {
    const result = deriveContextWindowWarning(
      snapshot({
        usedPercentage: 99.4,
        maxTokens: 200_000,
        remainingTokens: 1_200,
      }),
    );
    assert.deepEqual(result, {
      usedPercentageRounded: 99,
      remainingTokens: 1_200,
    });
  });
});
