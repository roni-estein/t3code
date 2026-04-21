/**
 * SessionReconciliation tests
 *
 * Covers the three public entry points of the service:
 *   - `reconcileStartupSweep` — walks the read model, identifies stuck
 *     rows, and dispatches synthetic `thread.session.set` events.
 *   - `diagnose` — returns a divergence report for one thread; never
 *     writes.
 *   - `reconcileThread` — same predicate as the sweep, but scoped to
 *     one thread; reports `not-stuck` / `thread-missing` where
 *     applicable.
 *
 * Harness mirrors `ProviderRuntimeIngestion.test.ts` — in-memory
 * SQLite, a real `OrchestrationEngineLive`, and the full projection
 * pipeline so the synthetic events round-trip through the projector.
 */
import {
  type CommandId,
  CommandId as CommandIdCtor,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { SessionReconciliationLive, evaluateDivergence } from "./SessionReconciliation.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  SessionReconciliationService,
  type SessionReconciliationShape,
} from "../Services/SessionReconciliation.ts";
import type { ProjectionTurnRepositoryShape } from "../../persistence/Services/ProjectionTurns.ts";
import type { ProviderSessionRuntimeRepositoryShape } from "../../persistence/Services/ProviderSessionRuntime.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCommandId = (value: string): CommandId => CommandIdCtor.make(value);
const asIsoDateTime = (value: string) => IsoDateTime.make(value);

/**
 * Shared layer graph: in-memory SQLite + full orchestration pipeline +
 * reconciliation service + runtime repo. Ordering matters — the
 * reconciliation service consumes the runtime repo, the engine, and
 * the projection turn repo, so we merge those together before
 * providing SqlitePersistenceMemory underneath.
 */
function makeTestLayer() {
  // Engine + projection + persistence. We provide the orchestration
  // deps via `provideMerge` so the resulting layer still exposes them
  // (the reconciliation layer consumes several of them).
  //
  // Layer ordering: later `provideMerge` calls layer below earlier
  // ones (they supply services consumed by the earlier layers).
  // NodeServices.layer provides FileSystem / Path, which
  // ServerConfig.layerTest needs, so NodeServices lives at the
  // bottom.
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-reconcile-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const baseLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProviderSessionRuntimeRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return SessionReconciliationLive.pipe(Layer.provideMerge(baseLayer));
}

interface TestHarness {
  readonly engine: OrchestrationEngineShape;
  readonly reconciliation: SessionReconciliationShape;
  readonly turnRepo: ProjectionTurnRepositoryShape;
  readonly runtimeRepo: ProviderSessionRuntimeRepositoryShape;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    | SessionReconciliationService
    | OrchestrationEngineService
    | ProjectionTurnRepository
    | ProviderSessionRuntimeRepository,
    unknown
  >;
}

async function createHarness(): Promise<TestHarness> {
  const runtime = ManagedRuntime.make(makeTestLayer());
  const [engine, reconciliation, turnRepo, runtimeRepo] = await Promise.all([
    runtime.runPromise(Effect.service(OrchestrationEngineService)),
    runtime.runPromise(Effect.service(SessionReconciliationService)),
    runtime.runPromise(Effect.service(ProjectionTurnRepository)),
    runtime.runPromise(Effect.service(ProviderSessionRuntimeRepository)),
  ]);
  return { engine, reconciliation, turnRepo, runtimeRepo, runtime };
}

async function seedStuckThread(
  harness: TestHarness,
  opts: {
    readonly threadId: ThreadId;
    readonly projectId?: ProjectId;
    readonly turnId?: TurnId;
    readonly turnCompletedAt?: string;
  },
) {
  const projectId = opts.projectId ?? asProjectId(`project-${opts.threadId}`);
  const turnId = opts.turnId ?? asTurnId(`turn-${opts.threadId}`);
  const createdAt = new Date().toISOString();

  await harness.runtime.runPromise(
    harness.engine.dispatch({
      type: "project.create",
      commandId: asCommandId(`cmd-project-${opts.threadId}`),
      projectId,
      title: `Project ${opts.threadId}`,
      workspaceRoot: `/tmp/${opts.threadId}`,
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt,
    }),
  );
  await harness.runtime.runPromise(
    harness.engine.dispatch({
      type: "thread.create",
      commandId: asCommandId(`cmd-thread-${opts.threadId}`),
      threadId: opts.threadId,
      projectId,
      title: `Thread ${opts.threadId}`,
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
  // Seed a `running` session with an anchor turn.
  await harness.runtime.runPromise(
    harness.engine.dispatch({
      type: "thread.session.set",
      commandId: asCommandId(`cmd-session-${opts.threadId}`),
      threadId: opts.threadId,
      session: {
        threadId: opts.threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: asIsoDateTime(createdAt),
      },
      createdAt: asIsoDateTime(createdAt),
    }),
  );

  // Write the anchor turn into projection_turns in a COMPLETED state
  // so the divergence predicate picks it up. We go directly through
  // the projection repo here — the engine doesn't take turn.complete
  // commands from user code, and using the repo lets the test
  // target the stuck-after-crash scenario precisely.
  await harness.runtime.runPromise(
    harness.turnRepo.upsertByTurnId({
      threadId: opts.threadId,
      turnId,
      pendingMessageId: null,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: null,
      state: "completed",
      requestedAt: asIsoDateTime(createdAt),
      startedAt: asIsoDateTime(createdAt),
      completedAt: asIsoDateTime(opts.turnCompletedAt ?? createdAt),
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
    }),
  );
}

describe("evaluateDivergence (pure predicate)", () => {
  it("returns not-stuck when session status is ready", () => {
    expect(
      evaluateDivergence({
        sessionStatus: "ready",
        activeTurnId: null,
        activeTurnState: null,
        activeTurnCompletedAt: null,
        runtimeStatus: null,
      }).isStuck,
    ).toBe(false);
  });

  it("marks running session with null active turn as stuck", () => {
    const result = evaluateDivergence({
      sessionStatus: "running",
      activeTurnId: null,
      activeTurnState: null,
      activeTurnCompletedAt: null,
      runtimeStatus: null,
    });
    expect(result.isStuck).toBe(true);
    expect(result.reason).toContain("null active_turn_id");
  });

  it("marks running session as stuck when anchor turn is completed", () => {
    const result = evaluateDivergence({
      sessionStatus: "running",
      activeTurnId: "turn-x",
      activeTurnState: "completed",
      activeTurnCompletedAt: "2026-04-20T00:00:00.000Z",
      runtimeStatus: null,
    });
    expect(result.isStuck).toBe(true);
    expect(result.reason).toContain("terminal state");
  });

  it("marks running session as stuck when runtime is stopped", () => {
    const result = evaluateDivergence({
      sessionStatus: "running",
      activeTurnId: "turn-x",
      activeTurnState: "running",
      activeTurnCompletedAt: null,
      runtimeStatus: "stopped",
    });
    expect(result.isStuck).toBe(true);
    expect(result.reason).toContain("stopped");
  });

  it("does not flag a healthy running turn", () => {
    expect(
      evaluateDivergence({
        sessionStatus: "running",
        activeTurnId: "turn-x",
        activeTurnState: "running",
        activeTurnCompletedAt: null,
        runtimeStatus: "running",
      }).isStuck,
    ).toBe(false);
  });
});

describe("SessionReconciliationService", () => {
  let harness: TestHarness | null = null;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    if (harness) {
      await harness.runtime.dispose();
    }
    harness = null;
  });

  it("startup sweep dispatches a synthetic session.ready for stuck rows", async () => {
    if (!harness) throw new Error("missing harness");
    const threadId = asThreadId("thread-stuck-1");
    await seedStuckThread(harness, { threadId });

    // Sanity check: projection says running.
    const beforeModel = await harness.runtime.runPromise(harness.engine.getReadModel());
    const beforeThread = beforeModel.threads.find((t) => t.id === threadId);
    expect(beforeThread?.session?.status).toBe("running");

    const result = await harness.runtime.runPromise(harness.reconciliation.reconcileStartupSweep());
    expect(result.scanned).toBe(1);
    expect(result.reconciled).toHaveLength(1);
    expect(result.reconciled[0]?.isStuck).toBe(true);

    // After the sweep, the read model should reflect status='ready'
    // and activeTurnId=null.
    const afterModel = await harness.runtime.runPromise(harness.engine.getReadModel());
    const afterThread = afterModel.threads.find((t) => t.id === threadId);
    expect(afterThread?.session?.status).toBe("ready");
    expect(afterThread?.session?.activeTurnId).toBeNull();
  });

  it("startup sweep ignores threads that are already healthy", async () => {
    if (!harness) throw new Error("missing harness");
    const threadId = asThreadId("thread-healthy-1");
    const projectId = asProjectId(`project-${threadId}`);
    const createdAt = new Date().toISOString();

    await harness.runtime.runPromise(
      harness.engine.dispatch({
        type: "project.create",
        commandId: asCommandId(`cmd-project-${threadId}`),
        projectId,
        title: "Healthy project",
        workspaceRoot: `/tmp/${threadId}`,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await harness.runtime.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: asCommandId(`cmd-thread-${threadId}`),
        threadId,
        projectId,
        title: "Healthy thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await harness.runtime.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: asCommandId(`cmd-session-${threadId}`),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: asIsoDateTime(createdAt),
        },
        createdAt: asIsoDateTime(createdAt),
      }),
    );

    const result = await harness.runtime.runPromise(harness.reconciliation.reconcileStartupSweep());
    expect(result.scanned).toBe(0);
    expect(result.reconciled).toHaveLength(0);
  });

  it("diagnose returns a report without mutating state", async () => {
    if (!harness) throw new Error("missing harness");
    const threadId = asThreadId("thread-diagnose-1");
    await seedStuckThread(harness, { threadId });

    const report = await harness.runtime.runPromise(harness.reconciliation.diagnose(threadId));
    expect(report.threadId).toBe(threadId);
    expect(report.sessionStatus).toBe("running");
    expect(report.isStuck).toBe(true);

    // diagnose must not write — projection stays 'running'.
    const model = await harness.runtime.runPromise(harness.engine.getReadModel());
    const thread = model.threads.find((t) => t.id === threadId);
    expect(thread?.session?.status).toBe("running");
  });

  it("reconcileThread heals a single thread and returns 'reconciled'", async () => {
    if (!harness) throw new Error("missing harness");
    const threadId = asThreadId("thread-reconcile-1");
    await seedStuckThread(harness, { threadId });

    const outcome = await harness.runtime.runPromise(
      harness.reconciliation.reconcileThread(threadId),
    );
    expect(outcome._tag).toBe("reconciled");

    const model = await harness.runtime.runPromise(harness.engine.getReadModel());
    const thread = model.threads.find((t) => t.id === threadId);
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("reconcileThread returns 'not-stuck' for a healthy thread", async () => {
    if (!harness) throw new Error("missing harness");
    const threadId = asThreadId("thread-reconcile-healthy");
    const projectId = asProjectId(`project-${threadId}`);
    const createdAt = new Date().toISOString();

    await harness.runtime.runPromise(
      harness.engine.dispatch({
        type: "project.create",
        commandId: asCommandId(`cmd-project-${threadId}`),
        projectId,
        title: "Healthy project",
        workspaceRoot: `/tmp/${threadId}`,
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await harness.runtime.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: asCommandId(`cmd-thread-${threadId}`),
        threadId,
        projectId,
        title: "Healthy thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await harness.runtime.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: asCommandId(`cmd-session-${threadId}`),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: asIsoDateTime(createdAt),
        },
        createdAt: asIsoDateTime(createdAt),
      }),
    );

    const outcome = await harness.runtime.runPromise(
      harness.reconciliation.reconcileThread(threadId),
    );
    expect(outcome._tag).toBe("not-stuck");
  });

  it("reconcileThread returns 'thread-missing' for an unknown thread id", async () => {
    if (!harness) throw new Error("missing harness");
    const threadId = asThreadId("thread-never-existed");
    const outcome = await harness.runtime.runPromise(
      harness.reconciliation.reconcileThread(threadId),
    );
    expect(outcome._tag).toBe("thread-missing");
  });
});

// Suppress unused-import warning on Schema / NonNegativeInt in case
// future test seeds need them. Keeping the imports documents the
// intended provenance of any NonNegativeInt values.
void Schema;
void NonNegativeInt;
