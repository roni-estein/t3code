/**
 * Pure decision layer for the context-saturation banner.
 *
 * Separated from the React component so it can be covered by fast unit
 * tests without needing to render the Alert + its dependencies. Shape
 * mirrors the `RecoveryProgressOverlay.logic.ts` split used by its
 * sibling overlay.
 *
 * @module ContextWindowWarningBanner.logic
 */
import type { ContextWindowSnapshot } from "~/lib/contextWindow";

/**
 * Threshold (inclusive) above which we surface the banner. Chosen at
 * 75% so users have runway to run `/compact` before Claude starts
 * auto-compacting (which loses fidelity) or before the context window
 * saturates outright.
 *
 * Exposed for tests; production callers should go through
 * `deriveContextWindowWarning` rather than reading this directly.
 */
export const CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT = 75;

/**
 * View-model for the banner. `null` means "don't render".
 *
 * `usedPercentageRounded` is what the banner displays. `remainingTokens`
 * is a rough countdown in the subtitle — only shown when the underlying
 * `maxTokens` is known (i.e., `remainingTokens !== null`).
 */
export interface ContextWindowWarningViewModel {
  readonly usedPercentageRounded: number;
  readonly remainingTokens: number | null;
}

/**
 * Decide whether the banner should show, and if so, what numbers to
 * display.
 *
 * Returns `null` when any of the following are true:
 *   - `usage` is null (no context-window event received yet).
 *   - `usage.usedPercentage` is null (`maxTokens` unknown; we can't
 *     compute saturation and don't want a "???% used" banner).
 *   - `usage.usedPercentage` is below the warning threshold.
 *   - `usage.compactsAutomatically === true`. The provider handles
 *     compaction for us; nagging the user to run `/compact` manually
 *     in that case is redundant noise.
 */
export function deriveContextWindowWarning(
  usage: ContextWindowSnapshot | null,
): ContextWindowWarningViewModel | null {
  if (!usage) return null;
  if (usage.compactsAutomatically) return null;
  if (usage.usedPercentage === null) return null;
  if (usage.usedPercentage < CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT) return null;

  return {
    usedPercentageRounded: Math.round(usage.usedPercentage),
    remainingTokens: usage.remainingTokens,
  };
}
