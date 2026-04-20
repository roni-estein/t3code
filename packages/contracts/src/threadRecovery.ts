/**
 * Thread recovery wire contracts.
 *
 * The server-side implementation of the 5-step recovery waterfall lives
 * in `apps/server/src/provider/Services/ThreadRecovery.ts` and
 * `apps/server/src/provider/Layers/ThreadRecovery.ts`. This file exposes
 * the Schemas that cross the RPC boundary so the web client can render
 * recovery progress and consume the final outcome.
 *
 * See also `rpc.ts` for the WS method declarations that reference these
 * schemas.
 *
 * @module contracts/threadRecovery
 */
import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationSessionStatus, ProviderSessionRuntimeStatus } from "./orchestration.ts";

/**
 * RecoveryStep - Identifier for each rung of the recovery waterfall.
 *
 * Keep this list in lock-step with the server-side `RecoveryStep` type
 * in `apps/server/src/provider/Services/ThreadRecovery.ts`. The ordering
 * is preserved by the server when it reports `attemptedSteps`.
 */
export const RecoveryStep = Schema.Literals([
  "session-key",
  "file-reference",
  "scan-current-cwd",
  "scan-all-cwds",
  "db-replay",
]);
export type RecoveryStep = typeof RecoveryStep.Type;

/**
 * RecoverInput - Payload for `threadRecovery.recover`.
 *
 * `cwd` is the workspace root the thread is running in. The server
 * encodes it into `~/.claude/projects/<cwd-encoded>/` for scanning.
 */
export const RecoverInput = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String,
});
export type RecoverInput = typeof RecoverInput.Type;

const RecoveryOutcomeResumed = Schema.TaggedStruct("resumed", {
  step: RecoveryStep,
  sessionKey: Schema.String,
  filePath: Schema.String,
});

const RecoveryOutcomeReplayWithTranscript = Schema.TaggedStruct("replay-with-transcript", {
  step: Schema.Literal("db-replay"),
  transcript: Schema.String,
  messageCount: NonNegativeInt,
});

const RecoveryOutcomeFailed = Schema.TaggedStruct("failed", {
  attemptedSteps: Schema.Array(RecoveryStep),
  detail: Schema.String,
});

/**
 * RecoveryOutcome - Tagged union describing what the waterfall found.
 *
 * - `resumed`: hand `sessionKey` to `claude --resume`. `filePath` is the
 *   JSONL that was validated.
 * - `replay-with-transcript`: start a fresh Claude session and prepend
 *   `transcript` as the first user-turn content. Claude sees prior
 *   context.
 * - `failed`: every step erred. Rare — db-replay is the floor and
 *   succeeds for any thread that has projected messages.
 */
export const RecoveryOutcome = Schema.Union([
  RecoveryOutcomeResumed,
  RecoveryOutcomeReplayWithTranscript,
  RecoveryOutcomeFailed,
]);
export type RecoveryOutcome = typeof RecoveryOutcome.Type;

const RecoveryEventStarted = Schema.TaggedStruct("started", {
  threadId: ThreadId,
  cwd: Schema.String,
});

const RecoveryEventStepStarted = Schema.TaggedStruct("step-started", {
  threadId: ThreadId,
  step: RecoveryStep,
});

const RecoveryEventStepSkipped = Schema.TaggedStruct("step-skipped", {
  threadId: ThreadId,
  step: RecoveryStep,
  reason: Schema.String,
});

const RecoveryEventStepSucceeded = Schema.TaggedStruct("step-succeeded", {
  threadId: ThreadId,
  step: RecoveryStep,
  detail: Schema.String,
});

const RecoveryEventStepFailed = Schema.TaggedStruct("step-failed", {
  threadId: ThreadId,
  step: RecoveryStep,
  reason: Schema.String,
});

const RecoveryEventCompleted = Schema.TaggedStruct("completed", {
  threadId: ThreadId,
  outcome: RecoveryOutcome,
});

/**
 * RecoveryProgressEvent - Streamed over the `threadRecovery.recover` RPC.
 *
 * Order on the wire:
 *   started → step-started → (step-succeeded | step-skipped | step-failed)
 *           → (repeat step-* for each attempted rung)
 *           → completed
 *
 * The terminal event is always `completed`; the stream closes immediately
 * after. UI consumers should treat `completed` as the end-of-stream
 * sentinel and use `completed.outcome` for their response.
 */
export const RecoveryProgressEvent = Schema.Union([
  RecoveryEventStarted,
  RecoveryEventStepStarted,
  RecoveryEventStepSkipped,
  RecoveryEventStepSucceeded,
  RecoveryEventStepFailed,
  RecoveryEventCompleted,
]);
export type RecoveryProgressEvent = typeof RecoveryProgressEvent.Type;

/**
 * ThreadRecoveryRpcError - Wire-facing error for the recovery RPC.
 *
 * The server maps internal errors (persistence failures, process
 * problems, etc.) to this shape before bubbling them to the client.
 * `attemptedSteps` carries the same trace info as the server's
 * `ThreadRecoveryError` so the UI can show which rung broke.
 */
export class ThreadRecoveryRpcError extends Schema.TaggedErrorClass<ThreadRecoveryRpcError>()(
  "ThreadRecoveryRpcError",
  {
    message: TrimmedNonEmptyString,
    attemptedSteps: Schema.Array(RecoveryStep),
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * DebugBreakInput - Payload for `threadRecovery.debugBreak`.
 *
 * Clears `session_key` + `file_reference` on `project_history` for the
 * given thread so that the next turn's session-resume attempt will
 * exercise the recovery waterfall end-to-end (scan-current-cwd or
 * db-replay, depending on what's on disk).
 *
 * Intended as a development / QA aid — invoked from the
 * `/debug-break-thread` slash command.
 */
export const DebugBreakInput = Schema.Struct({
  threadId: ThreadId,
});
export type DebugBreakInput = typeof DebugBreakInput.Type;

/**
 * DiagnoseInput - Payload for `threadRecovery.diagnose`.
 *
 * Returns a read-only divergence report for the thread identified by
 * `threadId`. Used by the `/diagnose-thread [<uuid>]` slash command.
 */
export const DiagnoseInput = Schema.Struct({
  threadId: ThreadId,
});
export type DiagnoseInput = typeof DiagnoseInput.Type;

/**
 * SessionDiagnosticReport - Divergence snapshot for a single thread.
 *
 * Joins signals from three sources:
 *   - `projection_thread_sessions` (projector-owned): `sessionStatus`,
 *     `activeTurnId`. This is what the UI's "Working" pill reads.
 *   - `projection_turns` (projector-owned): `activeTurnState`,
 *     `activeTurnCompletedAt`. Lets the diagnose logic tell whether
 *     the referenced active turn is actually still running or has
 *     completed.
 *   - `provider_session_runtime` (imperative): `runtimeStatus`,
 *     `runtimeLastSeenAt`. Lets the diagnose logic tell whether the
 *     provider process is still alive.
 *
 * `isStuck` is true when the projection says "running" but either (a)
 * there is no active turn id, (b) the active turn has completed, or
 * (c) the runtime is stopped. Mirrors the startup sweep's predicate.
 */
export const SessionDiagnosticReport = Schema.Struct({
  threadId: ThreadId,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  activeTurnId: Schema.NullOr(Schema.String),
  activeTurnState: Schema.NullOr(Schema.String),
  activeTurnCompletedAt: Schema.NullOr(IsoDateTime),
  runtimeStatus: Schema.NullOr(ProviderSessionRuntimeStatus),
  runtimeLastSeenAt: Schema.NullOr(IsoDateTime),
  isStuck: Schema.Boolean,
  stuckReason: Schema.NullOr(Schema.String),
});
export type SessionDiagnosticReport = typeof SessionDiagnosticReport.Type;

/**
 * ReconcileInput - Payload for `threadRecovery.reconcile`.
 *
 * Runs Phase-1 reconciliation logic on a single thread on demand. Safe
 * to invoke anytime because the synthetic `session.ready` event is
 * idempotent at the projector.
 */
export const ReconcileInput = Schema.Struct({
  threadId: ThreadId,
});
export type ReconcileInput = typeof ReconcileInput.Type;

/**
 * ReconcileOutcome - Result of a single-thread reconcile attempt.
 *
 * - `reconciled`: a synthetic `session.ready` event was dispatched and
 *   the projection row should now reflect `status='ready'` +
 *   `active_turn_id=null`. The pre-reconcile report is included for
 *   the UI's audit toast.
 * - `not-stuck`: the thread was already in a healthy state; no event
 *   was dispatched.
 * - `thread-missing`: the thread id is unknown to the read model. UI
 *   should treat this as user error (bad uuid argument).
 */
const ReconcileOutcomeReconciled = Schema.TaggedStruct("reconciled", {
  report: SessionDiagnosticReport,
  reconciledAt: IsoDateTime,
});

const ReconcileOutcomeNotStuck = Schema.TaggedStruct("not-stuck", {
  report: SessionDiagnosticReport,
});

const ReconcileOutcomeThreadMissing = Schema.TaggedStruct("thread-missing", {
  threadId: ThreadId,
});

export const ReconcileOutcome = Schema.Union([
  ReconcileOutcomeReconciled,
  ReconcileOutcomeNotStuck,
  ReconcileOutcomeThreadMissing,
]);
export type ReconcileOutcome = typeof ReconcileOutcome.Type;

/**
 * SessionReconciliationRpcError - Wire-facing error for the diagnose /
 * reconcile RPCs. Mirrors `ThreadRecoveryRpcError` in shape.
 */
export class SessionReconciliationRpcError extends Schema.TaggedErrorClass<SessionReconciliationRpcError>()(
  "SessionReconciliationRpcError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * WS method identifiers for the thread-recovery RPC family.
 * Namespaced under `threadRecovery.` to keep WS method names grouped
 * by aggregate (matches the existing `git.*`, `terminal.*`, etc.
 * convention in `rpc.ts`).
 */
export const THREAD_RECOVERY_WS_METHODS = {
  recover: "threadRecovery.recover",
  debugBreak: "threadRecovery.debugBreak",
  diagnose: "threadRecovery.diagnose",
  reconcile: "threadRecovery.reconcile",
} as const;
