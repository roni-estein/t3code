import type { RecoveryOutcome, RecoveryProgressEvent, RecoveryStep } from "@t3tools/contracts";

/**
 * Pure state-reducer for the thread-recovery waterfall overlay.
 *
 * The server emits a stream of `RecoveryProgressEvent`s; this module folds
 * them into a flat view-model that the React component can render without
 * any branching on event shape at the JSX level.
 *
 * See `apps/server/src/provider/Services/ThreadRecovery.ts` for the
 * server-side waterfall contract and `packages/contracts/src/threadRecovery.ts`
 * for the wire schemas.
 */

/**
 * Runtime state of a single rung of the waterfall.
 *
 * - `pending`   — haven't started it yet (initial state for every step).
 * - `running`   — `step-started` received, no terminal event yet.
 * - `succeeded` — `step-succeeded` received. `detail` carries the server's
 *                 descriptive message (e.g. path to the JSONL it reused).
 * - `skipped`   — `step-skipped` received. `reason` is the server's
 *                 explanation (e.g. "no stored session_key").
 * - `failed`    — `step-failed` received. `reason` describes the failure.
 */
export type RecoveryStepStatus = "pending" | "running" | "succeeded" | "skipped" | "failed";

/**
 * View-model entry for a single step. `label` is display-ready so the
 * component doesn't have to care about the enum mapping.
 */
export interface RecoveryStepView {
  readonly step: RecoveryStep;
  readonly label: string;
  readonly status: RecoveryStepStatus;
  readonly detail: string | null;
}

/**
 * Top-level view-model of the overlay.
 *
 * - `phase` — which banner to show:
 *     - `idle`        — never received `started` yet.
 *     - `running`     — between `started` and `completed`.
 *     - `completed`   — terminal `completed` event received.
 * - `steps` — ordered view-models for every rung of the waterfall.
 * - `outcome` — populated once `completed` arrives.
 */
export interface RecoveryOverlayViewModel {
  readonly phase: "idle" | "running" | "completed";
  readonly steps: ReadonlyArray<RecoveryStepView>;
  readonly outcome: RecoveryOutcome | null;
}

/**
 * Canonical ordering of the waterfall — must match server-side `STEP_ORDER`
 * in `apps/server/src/provider/Layers/ThreadRecovery.ts` so the UI shows
 * rungs in the order the server attempts them.
 */
const STEP_ORDER: ReadonlyArray<RecoveryStep> = [
  "session-key",
  "file-reference",
  "scan-current-cwd",
  "scan-all-cwds",
  "db-replay",
];

const STEP_LABELS: Readonly<Record<RecoveryStep, string>> = {
  "session-key": "Use stored session key",
  "file-reference": "Use cached JSONL path",
  "scan-current-cwd": "Scan current workspace JSONLs",
  "scan-all-cwds": "Scan all workspace JSONLs",
  "db-replay": "Rebuild from database history",
};

const INITIAL_STEPS: ReadonlyArray<RecoveryStepView> = STEP_ORDER.map((step) => ({
  step,
  label: STEP_LABELS[step],
  status: "pending" as const,
  detail: null,
}));

/**
 * The starting view-model: no events received, every step pending.
 */
export const initialRecoveryOverlayViewModel: RecoveryOverlayViewModel = {
  phase: "idle",
  steps: INITIAL_STEPS,
  outcome: null,
};

/**
 * Apply a single progress event to the view-model.
 *
 * Pure function; deterministic for a given (model, event) pair. Safe to
 * call from a `useReducer` or from tests that fold a prerecorded event
 * sequence.
 */
export function applyRecoveryProgressEvent(
  model: RecoveryOverlayViewModel,
  event: RecoveryProgressEvent,
): RecoveryOverlayViewModel {
  switch (event._tag) {
    case "started":
      // Reset the waterfall — a recovery run might be retried after
      // completion, so re-starting must clear stale per-step detail.
      return {
        phase: "running",
        steps: INITIAL_STEPS,
        outcome: null,
      };

    case "step-started":
      return {
        ...model,
        phase: "running",
        steps: model.steps.map((entry) =>
          entry.step === event.step
            ? { ...entry, status: "running" as const, detail: null }
            : entry,
        ),
      };

    case "step-succeeded":
      return {
        ...model,
        steps: model.steps.map((entry) =>
          entry.step === event.step
            ? { ...entry, status: "succeeded" as const, detail: event.detail }
            : entry,
        ),
      };

    case "step-skipped":
      return {
        ...model,
        steps: model.steps.map((entry) =>
          entry.step === event.step
            ? { ...entry, status: "skipped" as const, detail: event.reason }
            : entry,
        ),
      };

    case "step-failed":
      return {
        ...model,
        steps: model.steps.map((entry) =>
          entry.step === event.step
            ? { ...entry, status: "failed" as const, detail: event.reason }
            : entry,
        ),
      };

    case "completed":
      return {
        ...model,
        phase: "completed",
        outcome: event.outcome,
      };

    default: {
      // Exhaustiveness check — if a new event _tag is added without a
      // matching branch above this will surface at compile time.
      const _exhaustive: never = event;
      return model;
    }
  }
}

/**
 * Fold a prerecorded event list into a final view-model. Handy in tests.
 */
export function foldRecoveryProgressEvents(
  events: ReadonlyArray<RecoveryProgressEvent>,
  initial: RecoveryOverlayViewModel = initialRecoveryOverlayViewModel,
): RecoveryOverlayViewModel {
  return events.reduce(applyRecoveryProgressEvent, initial);
}

/**
 * Derive a human-readable summary sentence from a terminal outcome.
 * Used by the overlay footer + for telemetry logs.
 */
export function summarizeRecoveryOutcome(outcome: RecoveryOutcome): string {
  switch (outcome._tag) {
    case "resumed":
      return `Resumed via ${STEP_LABELS[outcome.step].toLowerCase()}.`;
    case "replay-with-transcript":
      return `Rebuilt ${outcome.messageCount} message${
        outcome.messageCount === 1 ? "" : "s"
      } from database history.`;
    case "failed":
      return outcome.detail.length > 0 ? `Recovery failed: ${outcome.detail}` : "Recovery failed.";
    default: {
      const _exhaustive: never = outcome;
      return "Recovery finished.";
    }
  }
}
