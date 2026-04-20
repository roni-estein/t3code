/**
 * SessionReconciliationService - Heals divergence between
 * `projection_thread_sessions.status` (projector-owned) and the
 * underlying runtime state.
 *
 * Problem: the projection's `status` field drives the UI's "Working"
 * pill. When the event stream breaks mid-turn (process crash, WS drop
 * between a turn's start and its terminal event, etc.) the projection
 * can be left at `status='running'` forever even though the provider
 * runtime has stopped and the turn has actually completed. Without a
 * reconciliation step, the user's only recovery is raw SQL.
 *
 * Design (spec lives in project_pr3_session_projection_reconciliation.md):
 *
 *   1. **Startup-only sweep** — run at boot before WebSocket clients
 *      are accepted. At boot any `status='running'` row is definitionally
 *      stale (nothing has been spawned yet), so this predicate is safe
 *      against in-flight false positives like `/compact` or long tool
 *      calls.
 *   2. **On-demand reconcile** — the same logic, invoked for a specific
 *      thread via the `threadRecovery.reconcile` RPC. Used by the
 *      `/reconcile-thread [<uuid>]` slash command so the user can fix a
 *      stuck thread without restarting the server.
 *   3. **Diagnose** — read-only divergence snapshot. Used by the
 *      `/diagnose-thread [<uuid>]` slash command to show the user
 *      exactly which signals conflict before any remediation is applied.
 *
 * All writes go through the orchestration engine via synthetic
 * `thread.session.set` commands (status='ready', activeTurnId=null).
 * We explicitly DO NOT touch `projection_turns` — any interrupted turns
 * stay visible as interrupted in the UI, which is the user's cue that
 * the thread was broken.
 *
 * @module SessionReconciliationService
 */
import type { ThreadId } from "@t3tools/contracts";
import { type SessionDiagnosticReport, type ReconcileOutcome } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type {
  ProjectionRepositoryError,
  ProviderSessionRuntimeRepositoryError,
} from "../../persistence/Errors.ts";

// Re-export wire types so server-internal consumers don't need to reach
// across to @t3tools/contracts for them.
export type { ReconcileOutcome, SessionDiagnosticReport };

/**
 * SessionReconciliationError - Combined error channel for the service.
 *
 * Enumerates the typed failure modes that can surface at the boundary:
 *   - projection-repository reads (session / turn tables)
 *   - provider-runtime repository reads
 *   - engine dispatch failures (when we try to emit a synthetic
 *     `thread.session.set` command)
 */
export type SessionReconciliationError =
  | ProjectionRepositoryError
  | ProviderSessionRuntimeRepositoryError
  | OrchestrationDispatchError;

/**
 * ReconcileSweepResult - Return value of the startup sweep.
 *
 * `scanned` is the total number of rows inspected; `reconciled` is the
 * subset that produced a synthetic `session.ready` event. Rare drift is
 * expected (the sweep exists for a reason); frequent drift is a signal
 * worth chasing at the upstream event-stream source.
 */
export interface ReconcileSweepResult {
  readonly scanned: number;
  readonly reconciled: ReadonlyArray<SessionDiagnosticReport>;
}

export interface SessionReconciliationShape {
  /**
   * Run the startup reconciliation sweep. Intended to be invoked once
   * by `serverRuntimeStartup` before WebSocket listeners begin
   * accepting client commands. Safe to call more than once (idempotent
   * at the projector) but structured around a one-shot boot check.
   */
  readonly reconcileStartupSweep: () => Effect.Effect<
    ReconcileSweepResult,
    SessionReconciliationError
  >;

  /**
   * Diagnose a single thread. Returns a `SessionDiagnosticReport` with
   * the current projector/projection/runtime signals joined. Does not
   * write anything.
   */
  readonly diagnose: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionDiagnosticReport, SessionReconciliationError>;

  /**
   * Reconcile a single thread on demand. If the thread is not stuck
   * (per the same predicate the startup sweep uses) returns
   * `{ _tag: "not-stuck" }` without dispatching; otherwise emits a
   * synthetic `thread.session.set` (status='ready', activeTurnId=null)
   * and returns `{ _tag: "reconciled" }`.
   */
  readonly reconcileThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReconcileOutcome, SessionReconciliationError>;
}

export class SessionReconciliationService extends Context.Service<
  SessionReconciliationService,
  SessionReconciliationShape
>()("t3/orchestration/Services/SessionReconciliation/SessionReconciliationService") {}
