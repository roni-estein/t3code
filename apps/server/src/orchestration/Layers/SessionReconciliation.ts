/**
 * SessionReconciliationLive - Runtime implementation of the Phase-1
 * reconciliation service.
 *
 * See `../Services/SessionReconciliation.ts` for the service shape and
 * the full rationale. This file is the wiring: read the relevant rows
 * from the read-model + provider-runtime repo, decide whether the
 * thread is stuck, and (optionally) dispatch a synthetic
 * `thread.session.set` through the orchestration engine.
 *
 * Why dispatch instead of raw SQL writes: the projector already handles
 * the `thread.session-set` event type (see
 * `apps/server/src/orchestration/projector.ts:420`), so emitting a
 * synthetic command keeps the event log consistent and replay-safe.
 * Every reconciled row leaves an audit trail in `orchestration_events`.
 *
 * @module SessionReconciliationLive
 */
import {
  CommandId,
  IsoDateTime,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type ProviderSessionRuntimeStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  type ReconcileOutcome,
  type ReconcileSweepResult,
  type SessionDiagnosticReport,
  SessionReconciliationService,
  type SessionReconciliationShape,
} from "../Services/SessionReconciliation.ts";

/**
 * Result of the divergence check. Split from `SessionDiagnosticReport`
 * so we can use it internally without re-deriving `isStuck` twice.
 */
interface DivergenceCheck {
  readonly isStuck: boolean;
  readonly reason: string | null;
}

/**
 * evaluateDivergence - Encapsulates the "this thread is stuck" predicate.
 *
 * Called both at startup (for every row with `status='running'`) and
 * from the on-demand RPC. The predicate matches the design doc:
 *
 *   A thread is stuck iff its projection status is 'running' AND any
 *   of the following is true:
 *     - activeTurnId is null (running without an anchor turn)
 *     - the anchor turn's state is a terminal state (completed /
 *       interrupted / error) or it has a completedAt set
 *     - the provider runtime status is `stopped` (process is dead)
 *
 * Startup-only considerations are enforced at the caller level: the
 * startup sweep simply invokes this against every `running` row; the
 * on-demand reconcile calls the same predicate. No time-based
 * freshness gate — that deliberately keeps the logic simple and
 * predictable.
 */
function evaluateDivergence(input: {
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly activeTurnId: string | null;
  readonly activeTurnState: string | null;
  readonly activeTurnCompletedAt: string | null;
  readonly runtimeStatus: ProviderSessionRuntimeStatus | null;
}): DivergenceCheck {
  if (input.sessionStatus !== "running") {
    return { isStuck: false, reason: null };
  }
  if (input.activeTurnId === null) {
    return { isStuck: true, reason: "session.status=running with null active_turn_id" };
  }
  if (
    input.activeTurnState === "completed" ||
    input.activeTurnState === "interrupted" ||
    input.activeTurnState === "error"
  ) {
    return {
      isStuck: true,
      reason: `active turn ${input.activeTurnId} is in terminal state '${input.activeTurnState}'`,
    };
  }
  if (input.activeTurnCompletedAt !== null) {
    return {
      isStuck: true,
      reason: `active turn ${input.activeTurnId} has completed_at set`,
    };
  }
  if (input.runtimeStatus === "stopped") {
    return {
      isStuck: true,
      reason: "provider runtime status='stopped' while projection says 'running'",
    };
  }
  return { isStuck: false, reason: null };
}

const makeSessionReconciliation = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const turnRepository = yield* ProjectionTurnRepository;
  const runtimeRepository = yield* ProviderSessionRuntimeRepository;

  /**
   * collectReport - Build a `SessionDiagnosticReport` for one thread.
   *
   * Accepts the `OrchestrationSession` already loaded from the read
   * model (the sweep has it in hand anyway) and augments it with the
   * active-turn and provider-runtime rows via repository reads.
   */
  const collectReport = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession | null;
  }) =>
    Effect.gen(function* () {
      const { threadId, session } = input;
      const sessionStatus: OrchestrationSessionStatus | null = session?.status ?? null;
      const activeTurnId: string | null = session?.activeTurnId ?? null;

      // Look up the anchor turn if we have one; the projector stores
      // terminal state + completedAt here.
      let activeTurnState: string | null = null;
      let activeTurnCompletedAt: string | null = null;
      if (session?.activeTurnId) {
        const turnRow = yield* turnRepository.getByTurnId({
          threadId,
          turnId: session.activeTurnId,
        });
        const turn = Option.getOrUndefined(turnRow);
        if (turn) {
          activeTurnState = turn.state;
          activeTurnCompletedAt = turn.completedAt;
        }
      }

      // Look up the imperative provider-runtime row.
      const runtimeRow = yield* runtimeRepository.getByThreadId({ threadId });
      const runtime = Option.getOrUndefined(runtimeRow);
      const runtimeStatus: ProviderSessionRuntimeStatus | null = runtime?.status ?? null;
      const runtimeLastSeenAt: string | null = runtime?.lastSeenAt ?? null;

      const divergence = evaluateDivergence({
        sessionStatus,
        activeTurnId,
        activeTurnState,
        activeTurnCompletedAt,
        runtimeStatus,
      });

      const report: SessionDiagnosticReport = {
        threadId,
        sessionStatus,
        activeTurnId,
        activeTurnState,
        activeTurnCompletedAt: activeTurnCompletedAt
          ? IsoDateTime.make(activeTurnCompletedAt)
          : null,
        runtimeStatus,
        runtimeLastSeenAt: runtimeLastSeenAt ? IsoDateTime.make(runtimeLastSeenAt) : null,
        isStuck: divergence.isStuck,
        stuckReason: divergence.reason,
      };
      return report;
    });

  /**
   * dispatchSessionReady - Emit a synthetic `thread.session.set` event
   * that clears the stuck row. Using the engine (not a raw projector
   * write) keeps everything going through the same command pipeline
   * as normal traffic, including event-log audit + projector
   * idempotency.
   *
   * The synthetic command's `commandId` is namespaced under
   * `reconcile:` so it's easy to pick out in event logs. We always
   * force `status='ready'` and `activeTurnId=null` — this matches the
   * SQL surgical fix applied by hand on 2026-04-20.
   */
  const dispatchSessionReady = (input: {
    readonly threadId: ThreadId;
    readonly existingSession: OrchestrationSession | null;
    readonly reason: string;
  }) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const commandId = CommandId.make(`reconcile:${input.threadId}:${crypto.randomUUID()}`);
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId,
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: "ready",
          providerName: input.existingSession?.providerName ?? null,
          runtimeMode: input.existingSession?.runtimeMode ?? "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: IsoDateTime.make(now),
        },
        createdAt: IsoDateTime.make(now),
      });
      yield* Effect.logInfo("thread.session.reconciled", {
        threadId: input.threadId,
        reason: input.reason,
        commandId,
      });
      return now;
    });

  const diagnose: SessionReconciliationShape["diagnose"] = (threadId) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return yield* collectReport({
        threadId,
        session: thread?.session ?? null,
      });
    });

  const reconcileThread: SessionReconciliationShape["reconcileThread"] = (threadId) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      if (!thread) {
        const outcome: ReconcileOutcome = { _tag: "thread-missing", threadId };
        return outcome;
      }
      const report = yield* collectReport({
        threadId,
        session: thread.session,
      });
      if (!report.isStuck) {
        const outcome: ReconcileOutcome = { _tag: "not-stuck", report };
        return outcome;
      }
      const reconciledAt = yield* dispatchSessionReady({
        threadId,
        existingSession: thread.session,
        reason: report.stuckReason ?? "stuck",
      });
      const outcome: ReconcileOutcome = {
        _tag: "reconciled",
        report,
        reconciledAt: IsoDateTime.make(reconciledAt),
      };
      return outcome;
    });

  const reconcileStartupSweep: SessionReconciliationShape["reconcileStartupSweep"] = () =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      // Only inspect `running` rows. At boot these are the only ones
      // that can possibly be stale — anything in a terminal state
      // (ready/stopped/error/etc.) is already self-consistent.
      const candidates = readModel.threads.filter((thread) => thread.session?.status === "running");
      const reconciled: Array<SessionDiagnosticReport> = [];
      for (const thread of candidates) {
        const report = yield* collectReport({
          threadId: thread.id,
          session: thread.session,
        });
        if (!report.isStuck) {
          continue;
        }
        yield* dispatchSessionReady({
          threadId: thread.id,
          existingSession: thread.session,
          reason: report.stuckReason ?? "startup sweep",
        });
        reconciled.push(report);
      }
      if (reconciled.length > 0) {
        yield* Effect.logInfo("thread.session.reconciled.sweep", {
          scanned: candidates.length,
          reconciled: reconciled.length,
        });
      } else {
        yield* Effect.logDebug("thread.session.reconciled.sweep", {
          scanned: candidates.length,
          reconciled: 0,
        });
      }
      const result: ReconcileSweepResult = {
        scanned: candidates.length,
        reconciled,
      };
      return result;
    });

  return {
    reconcileStartupSweep,
    diagnose,
    reconcileThread,
  } satisfies SessionReconciliationShape;
});

export const SessionReconciliationLive = Layer.effect(
  SessionReconciliationService,
  makeSessionReconciliation,
);

// Re-exported here so tests/consumers that want to verify the
// predicate in isolation don't have to shadow it.
export { evaluateDivergence };
