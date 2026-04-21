import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IsoDateTime, MessageId, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionProjectHistoryRepositoryLive } from "../../persistence/Layers/ProjectionProjectHistory.ts";
import { ProjectionProjectHistoryRepository } from "../../persistence/Services/ProjectionProjectHistory.ts";
import { ProjectionProjectHistorySessionsRepositoryLive } from "../../persistence/Layers/ProjectionProjectHistorySessions.ts";
import { ProjectionProjectHistorySessionsRepository } from "../../persistence/Services/ProjectionProjectHistorySessions.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRecoveryService, type RecoveryOutcome } from "../Services/ThreadRecovery.ts";
import { encodeCwdForClaudeProjects } from "../sessionHealth.ts";
import { makeThreadRecoveryLive } from "./ThreadRecovery.ts";

function makeClaudeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-recovery-"));
  fs.mkdirSync(path.join(home, "projects"), { recursive: true });
  return home;
}

function makeRecoveryLayer(input: {
  readonly claudeHome: string;
  readonly freshnessWindowMs?: number;
}) {
  const projectHistoryLayer = ProjectionProjectHistoryRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectHistorySessionsLayer = ProjectionProjectHistorySessionsRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const threadMessageLayer = ProjectionThreadMessageRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  return Layer.mergeAll(
    projectHistoryLayer,
    projectHistorySessionsLayer,
    threadMessageLayer,
    makeThreadRecoveryLive({
      claudeHome: input.claudeHome,
      ...(input.freshnessWindowMs !== undefined
        ? { freshnessWindowMs: input.freshnessWindowMs }
        : {}),
    }).pipe(
      Layer.provide(projectHistoryLayer),
      Layer.provide(projectHistorySessionsLayer),
      Layer.provide(threadMessageLayer),
    ),
  );
}

function writeSessionFile(
  claudeHome: string,
  cwd: string,
  sessionId: string,
  content: string = '{"type":"fixture"}\n',
) {
  const dir = path.join(claudeHome, "projects", encodeCwdForClaudeProjects(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

function seedProjectHistory(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly sessionKey?: string | null;
  readonly fileReference?: string | null;
}) {
  return Effect.gen(function* () {
    const repo = yield* ProjectionProjectHistoryRepository;
    const now = IsoDateTime.make(new Date().toISOString());
    yield* repo.upsert({
      threadId: input.threadId,
      projectId: input.projectId,
      sessionKey: input.sessionKey ?? null,
      fileReference: input.fileReference ?? null,
      isArchived: Schema.decodeSync(NonNegativeInt)(0),
      isDeleted: Schema.decodeSync(NonNegativeInt)(0),
      createdAt: now,
      updatedAt: now,
    });
  });
}

function seedMessages(
  threadId: ThreadId,
  messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>,
) {
  return Effect.gen(function* () {
    const repo = yield* ProjectionThreadMessageRepository;
    const base = Date.now();
    for (const [i, m] of messages.entries()) {
      const ts = IsoDateTime.make(new Date(base + i * 1000).toISOString());
      yield* repo.upsert({
        messageId: MessageId.make(`msg-${threadId}-${i}`),
        threadId,
        turnId: null,
        role: m.role,
        text: m.text,
        isStreaming: false,
        createdAt: ts,
        updatedAt: ts,
      });
    }
  });
}

const step1Home = makeClaudeHome();
it.live("ThreadRecovery step 1: resumes via persisted session_key", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-recovery-step1");
    const projectId = ProjectId.make("project-recovery-step1");
    const cwd = "/tmp/step1-workspace";
    const sessionKey = "session-step1-live";
    const expectedPath = writeSessionFile(step1Home, cwd, sessionKey);

    yield* seedProjectHistory({
      threadId,
      projectId,
      sessionKey,
    });

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({ threadId, cwd });

    assert.equal(outcome._tag, "resumed");
    if (outcome._tag === "resumed") {
      assert.equal(outcome.step, "session-key");
      assert.equal(outcome.sessionKey, sessionKey);
      assert.equal(outcome.filePath, expectedPath);
    }
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: step1Home }))),
);

const step2Home = makeClaudeHome();
it.live(
  "ThreadRecovery step 2: falls through to file_reference when session_key file is missing",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-recovery-step2");
      const projectId = ProjectId.make("project-recovery-step2");
      const cwd = "/tmp/step2-workspace";

      // session_key points to a file that will NOT exist on disk.
      const staleSessionKey = "session-step2-stale";
      // file_reference points to a file that DOES exist, with a
      // different session id.
      const liveSessionKey = "session-step2-live";
      const liveFilePath = writeSessionFile(step2Home, cwd, liveSessionKey);

      yield* seedProjectHistory({
        threadId,
        projectId,
        sessionKey: staleSessionKey,
        fileReference: liveFilePath,
      });

      const recovery = yield* ThreadRecoveryService;
      const outcome: RecoveryOutcome = yield* recovery.recover({
        threadId,
        cwd,
      });

      assert.equal(outcome._tag, "resumed");
      if (outcome._tag === "resumed") {
        assert.equal(outcome.step, "file-reference");
        assert.equal(outcome.sessionKey, liveSessionKey);
        assert.equal(outcome.filePath, liveFilePath);
      }
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: step2Home }))),
);

const step3Home = makeClaudeHome();
it.live("ThreadRecovery step 3: scans current cwd when pointers are stale", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-recovery-step3");
    const projectId = ProjectId.make("project-recovery-step3");
    const cwd = "/tmp/step3-workspace";

    // No session_key or file_reference stored. There is an untracked
    // .jsonl sitting in the current-cwd projects dir from a prior run.
    const orphan = "session-step3-orphan";
    const orphanPath = writeSessionFile(step3Home, cwd, orphan);

    yield* seedProjectHistory({ threadId, projectId });

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({
      threadId,
      cwd,
    });

    assert.equal(outcome._tag, "resumed");
    if (outcome._tag === "resumed") {
      assert.equal(outcome.step, "scan-current-cwd");
      assert.equal(outcome.sessionKey, orphan);
      assert.equal(outcome.filePath, orphanPath);
    }

    // And: the successful scan should have cached the file_reference.
    const historyRepo = yield* ProjectionProjectHistoryRepository;
    const refreshed = yield* historyRepo.getById({ threadId });
    assert.equal(Option.isSome(refreshed), true);
    if (Option.isSome(refreshed)) {
      assert.equal(refreshed.value.fileReference, orphanPath);
    }
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: step3Home }))),
);

const step4Home = makeClaudeHome();
it.live("ThreadRecovery step 4: scans all cwds when current cwd has no JSONL", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-recovery-step4");
    const projectId = ProjectId.make("project-recovery-step4");
    const cwd = "/tmp/step4-workspace";
    const otherCwd = "/tmp/step4-other";

    // No JSONL in current cwd; one exists in another cwd dir.
    const orphan = "session-step4-other";
    const orphanPath = writeSessionFile(step4Home, otherCwd, orphan);

    yield* seedProjectHistory({ threadId, projectId });

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({
      threadId,
      cwd,
    });

    assert.equal(outcome._tag, "resumed");
    if (outcome._tag === "resumed") {
      assert.equal(outcome.step, "scan-all-cwds");
      assert.equal(outcome.sessionKey, orphan);
      assert.equal(outcome.filePath, orphanPath);
    }
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: step4Home }))),
);

const step5Home = makeClaudeHome();
it.live("ThreadRecovery step 5: falls back to DB replay when no filesystem evidence exists", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-recovery-step5");
    const projectId = ProjectId.make("project-recovery-step5");
    const cwd = "/tmp/step5-workspace";

    yield* seedProjectHistory({ threadId, projectId });
    yield* seedMessages(threadId, [
      { role: "user", text: "What's the capital of France?" },
      { role: "assistant", text: "Paris." },
      { role: "user", text: "And of Spain?" },
    ]);

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({
      threadId,
      cwd,
    });

    assert.equal(outcome._tag, "replay-with-transcript");
    if (outcome._tag === "replay-with-transcript") {
      assert.equal(outcome.messageCount, 3);
      assert.equal(outcome.step, "db-replay");
      assert.include(outcome.transcript, "User: What's the capital of France?");
      assert.include(outcome.transcript, "Assistant: Paris.");
      assert.include(outcome.transcript, "User: And of Spain?");
    }
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: step5Home }))),
);

const emptyHome = makeClaudeHome();
it.live("ThreadRecovery step 5: returns an empty transcript for a thread with no messages", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-recovery-empty");
    const projectId = ProjectId.make("project-recovery-empty");
    const cwd = "/tmp/empty-workspace";

    yield* seedProjectHistory({ threadId, projectId });

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({
      threadId,
      cwd,
    });

    assert.equal(outcome._tag, "replay-with-transcript");
    if (outcome._tag === "replay-with-transcript") {
      assert.equal(outcome.messageCount, 0);
      assert.equal(outcome.transcript, "");
    }
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: emptyHome }))),
);

const ownershipRejectHome = makeClaudeHome();
it.live(
  "ThreadRecovery rejects JSONL candidates owned by another thread during scan-current-cwd",
  () =>
    Effect.gen(function* () {
      // Two threads share the same cwd. Thread A tries to recover; the
      // cwd dir contains a JSONL belonging to thread B. The ownership
      // filter must reject B's JSONL and fall through to step 5
      // (db-replay), rather than silently hand A back B's transcript.
      const threadA = ThreadId.make("thread-collision-a");
      const threadB = ThreadId.make("thread-collision-b");
      const projectId = ProjectId.make("project-collision");
      const cwd = "/tmp/collision-workspace";

      const sessionA = "session-collision-a";
      const sessionB = "session-collision-b";

      // Both sessions are written to the same cwd-encoded dir. B's file
      // gets a newer mtime so the naive scan would pick it.
      writeSessionFile(ownershipRejectHome, cwd, sessionA);
      const pathB = writeSessionFile(ownershipRejectHome, cwd, sessionB);
      const futureMtime = new Date(Date.now() + 5 * 60 * 1000);
      fs.utimesSync(pathB, futureMtime, futureMtime);

      yield* seedProjectHistory({ threadId: threadA, projectId });

      // Pre-seed: sessionA and sessionB both catalogued, each to their
      // owning thread. With only A's project_history row, A's step 1
      // and 2 will skip; step 3 finds both JSONLs but must filter out
      // B's, then fall back because A's own JSONL in the dir has a
      // stale mtime (well within freshness window, but not the newest).
      // For simplicity we also catalog A's session so A's file would be
      // accepted if reached — the assertion below is just that A's
      // scan outcome was NOT B's file.
      const sessionsRepo = yield* ProjectionProjectHistorySessionsRepository;
      const t0 = IsoDateTime.make(new Date().toISOString());
      yield* sessionsRepo.recordSession({
        threadId: threadA,
        sessionKey: sessionA,
        firstSeenAt: t0,
      });
      yield* sessionsRepo.recordSession({
        threadId: threadB,
        sessionKey: sessionB,
        firstSeenAt: t0,
      });

      const recovery = yield* ThreadRecoveryService;
      const outcome: RecoveryOutcome = yield* recovery.recover({ threadId: threadA, cwd });

      // Outcome must be either A's own file (accepted after skipping B)
      // or db-replay. It must NOT be B's file.
      assert.notEqual(
        outcome._tag === "resumed" ? outcome.filePath : null,
        pathB,
        "ThreadRecovery returned a JSONL owned by a different thread",
      );
      if (outcome._tag === "resumed") {
        assert.equal(outcome.sessionKey, sessionA);
      }
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: ownershipRejectHome }))),
);

const uncataloguedAcceptHome = makeClaudeHome();
it.live("ThreadRecovery accepts an uncatalogued JSONL in cwd and records it for this thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-uncatalogued");
    const projectId = ProjectId.make("project-uncatalogued");
    const cwd = "/tmp/uncatalogued-workspace";
    const orphan = "session-uncatalogued";
    const orphanPath = writeSessionFile(uncataloguedAcceptHome, cwd, orphan);

    yield* seedProjectHistory({ threadId, projectId });
    // Intentionally do NOT seed project_history_sessions — the
    // session_key is unknown to the ownership filter.

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({ threadId, cwd });

    assert.equal(outcome._tag, "resumed");
    if (outcome._tag === "resumed") {
      assert.equal(outcome.step, "scan-current-cwd");
      assert.equal(outcome.sessionKey, orphan);
      assert.equal(outcome.filePath, orphanPath);
    }

    // And the successful scan should have catalogued the session_key
    // so subsequent scans can short-circuit the ownership check.
    const sessionsRepo = yield* ProjectionProjectHistorySessionsRepository;
    const owner = yield* sessionsRepo.getThreadByKey({ sessionKey: orphan });
    assert.equal(Option.isSome(owner), true);
    if (Option.isSome(owner)) {
      assert.equal(owner.value, threadId);
    }
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: uncataloguedAcceptHome }))),
);

const ownedSelfHome = makeClaudeHome();
it.live(
  "ThreadRecovery accepts a JSONL already catalogued to this thread without duplicating the row",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-self-owned");
      const projectId = ProjectId.make("project-self-owned");
      const cwd = "/tmp/self-owned-workspace";
      const owned = "session-self-owned";
      const ownedPath = writeSessionFile(ownedSelfHome, cwd, owned);

      yield* seedProjectHistory({ threadId, projectId });

      const sessionsRepo = yield* ProjectionProjectHistorySessionsRepository;
      const t0 = IsoDateTime.make(new Date().toISOString());
      yield* sessionsRepo.recordSession({
        threadId,
        sessionKey: owned,
        firstSeenAt: t0,
      });

      const recovery = yield* ThreadRecoveryService;
      const outcome: RecoveryOutcome = yield* recovery.recover({ threadId, cwd });

      assert.equal(outcome._tag, "resumed");
      if (outcome._tag === "resumed") {
        assert.equal(outcome.step, "scan-current-cwd");
        assert.equal(outcome.filePath, ownedPath);
      }

      // Sibling table should have exactly one row for this thread —
      // the one we pre-seeded. The scan must not have added a dupe.
      const history = yield* sessionsRepo.listByThreadId({ threadId });
      assert.equal(history.length, 1);
      assert.equal(history[0]?.sessionKey, owned);
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: ownedSelfHome }))),
);

const stalenessNewerSameThreadHome = makeClaudeHome();
it.live(
  "ThreadRecovery step 1 prefers a strictly-newer same-thread JSONL over the stored session_key",
  () =>
    Effect.gen(function* () {
      // Phase 3 staleness check. Stored session_key resolves to a valid
      // JSONL, but a fresher same-thread JSONL exists in the cwd
      // (simulates a /compact where the imperative sync failed to
      // advance session_key). The waterfall should return the fresher
      // JSONL's session_key.
      const threadId = ThreadId.make("thread-staleness-newer");
      const projectId = ProjectId.make("project-staleness-newer");
      const cwd = "/tmp/staleness-newer-workspace";

      const storedKey = "session-staleness-stored";
      const newerKey = "session-staleness-newer";
      const storedPath = writeSessionFile(stalenessNewerSameThreadHome, cwd, storedKey);
      const newerPath = writeSessionFile(stalenessNewerSameThreadHome, cwd, newerKey);

      // Stored is older, newer is newer — pinned via utimesSync.
      const older = new Date(Date.now() - 10 * 60 * 1000);
      const newer = new Date(Date.now() - 1 * 60 * 1000);
      fs.utimesSync(storedPath, older, older);
      fs.utimesSync(newerPath, newer, newer);

      yield* seedProjectHistory({
        threadId,
        projectId,
        sessionKey: storedKey,
      });

      // Catalog both session_keys to this thread so the ownership
      // filter accepts the newer one.
      const sessionsRepo = yield* ProjectionProjectHistorySessionsRepository;
      const t0 = IsoDateTime.make(new Date().toISOString());
      yield* sessionsRepo.recordSession({
        threadId,
        sessionKey: storedKey,
        firstSeenAt: t0,
      });
      yield* sessionsRepo.recordSession({
        threadId,
        sessionKey: newerKey,
        firstSeenAt: t0,
      });

      const recovery = yield* ThreadRecoveryService;
      const outcome: RecoveryOutcome = yield* recovery.recover({ threadId, cwd });

      assert.equal(outcome._tag, "resumed");
      if (outcome._tag === "resumed") {
        assert.equal(outcome.step, "session-key");
        assert.equal(outcome.sessionKey, newerKey);
        assert.equal(outcome.filePath, newerPath);
      }
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: stalenessNewerSameThreadHome }))),
);

const stalenessNewerForeignHome = makeClaudeHome();
it.live("ThreadRecovery step 1 ignores a strictly-newer foreign-thread JSONL when preferring", () =>
  Effect.gen(function* () {
    // Belt-and-suspenders: ownership filter still wins even in the
    // staleness-check path. Stored JSONL is ours; newer JSONL in cwd
    // is owned by another thread — waterfall must return the stored
    // one, not the newer foreign one.
    const threadId = ThreadId.make("thread-staleness-self");
    const otherThread = ThreadId.make("thread-staleness-foreign");
    const projectId = ProjectId.make("project-staleness-foreign");
    const cwd = "/tmp/staleness-foreign-workspace";

    const storedKey = "session-staleness-self-stored";
    const foreignKey = "session-staleness-foreign-newer";
    const storedPath = writeSessionFile(stalenessNewerForeignHome, cwd, storedKey);
    const foreignPath = writeSessionFile(stalenessNewerForeignHome, cwd, foreignKey);

    const older = new Date(Date.now() - 10 * 60 * 1000);
    const newer = new Date(Date.now() - 1 * 60 * 1000);
    fs.utimesSync(storedPath, older, older);
    fs.utimesSync(foreignPath, newer, newer);

    yield* seedProjectHistory({
      threadId,
      projectId,
      sessionKey: storedKey,
    });

    const sessionsRepo = yield* ProjectionProjectHistorySessionsRepository;
    const t0 = IsoDateTime.make(new Date().toISOString());
    yield* sessionsRepo.recordSession({
      threadId,
      sessionKey: storedKey,
      firstSeenAt: t0,
    });
    yield* sessionsRepo.recordSession({
      threadId: otherThread,
      sessionKey: foreignKey,
      firstSeenAt: t0,
    });

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({ threadId, cwd });

    assert.equal(outcome._tag, "resumed");
    if (outcome._tag === "resumed") {
      assert.equal(outcome.step, "session-key");
      assert.equal(outcome.sessionKey, storedKey);
      assert.equal(outcome.filePath, storedPath);
    }
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: stalenessNewerForeignHome }))),
);

const stalenessAloneHome = makeClaudeHome();
it.live(
  "ThreadRecovery step 1 returns the stored session_key when no other JSONLs exist in cwd",
  () =>
    Effect.gen(function* () {
      // Baseline: single JSONL in cwd, stored session_key points at it.
      // Staleness check finds no newer candidate and returns stored.
      const threadId = ThreadId.make("thread-staleness-alone");
      const projectId = ProjectId.make("project-staleness-alone");
      const cwd = "/tmp/staleness-alone-workspace";

      const storedKey = "session-staleness-alone";
      const storedPath = writeSessionFile(stalenessAloneHome, cwd, storedKey);

      yield* seedProjectHistory({
        threadId,
        projectId,
        sessionKey: storedKey,
      });

      const recovery = yield* ThreadRecoveryService;
      const outcome: RecoveryOutcome = yield* recovery.recover({ threadId, cwd });

      assert.equal(outcome._tag, "resumed");
      if (outcome._tag === "resumed") {
        assert.equal(outcome.step, "session-key");
        assert.equal(outcome.sessionKey, storedKey);
        assert.equal(outcome.filePath, storedPath);
      }
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: stalenessAloneHome }))),
);

const stalenessEqualMtimeHome = makeClaudeHome();
it.live(
  "ThreadRecovery step 1 returns the stored session_key when newest sibling has equal mtime",
  () =>
    Effect.gen(function* () {
      // Strictly-newer rule: equality does NOT qualify as newer, so the
      // stored key wins. This pins the threshold choice against
      // accidental drift to >= semantics.
      const threadId = ThreadId.make("thread-staleness-equal");
      const projectId = ProjectId.make("project-staleness-equal");
      const cwd = "/tmp/staleness-equal-workspace";

      const storedKey = "session-staleness-equal-stored";
      const siblingKey = "session-staleness-equal-sibling";
      const storedPath = writeSessionFile(stalenessEqualMtimeHome, cwd, storedKey);
      const siblingPath = writeSessionFile(stalenessEqualMtimeHome, cwd, siblingKey);

      const pinned = new Date(Date.now() - 5 * 60 * 1000);
      fs.utimesSync(storedPath, pinned, pinned);
      fs.utimesSync(siblingPath, pinned, pinned);

      yield* seedProjectHistory({
        threadId,
        projectId,
        sessionKey: storedKey,
      });

      const sessionsRepo = yield* ProjectionProjectHistorySessionsRepository;
      const t0 = IsoDateTime.make(new Date().toISOString());
      yield* sessionsRepo.recordSession({
        threadId,
        sessionKey: storedKey,
        firstSeenAt: t0,
      });
      yield* sessionsRepo.recordSession({
        threadId,
        sessionKey: siblingKey,
        firstSeenAt: t0,
      });

      const recovery = yield* ThreadRecoveryService;
      const outcome: RecoveryOutcome = yield* recovery.recover({ threadId, cwd });

      assert.equal(outcome._tag, "resumed");
      if (outcome._tag === "resumed") {
        assert.equal(outcome.step, "session-key");
        assert.equal(outcome.sessionKey, storedKey);
        assert.equal(outcome.filePath, storedPath);
      }
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: stalenessEqualMtimeHome }))),
);

const staleScanHome = makeClaudeHome();
it.live("ThreadRecovery skips filesystem scans outside the freshness window", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-recovery-stale-scan");
    const projectId = ProjectId.make("project-recovery-stale-scan");
    const cwd = "/tmp/stale-workspace";

    // Write a JSONL file, then set its mtime to 30 days ago. With a
    // 7-day freshness window, step 3 should reject it and fall through
    // to step 5 (db-replay returning an empty transcript).
    const ancient = "session-ancient";
    const ancientPath = writeSessionFile(staleScanHome, cwd, ancient);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(ancientPath, thirtyDaysAgo, thirtyDaysAgo);

    yield* seedProjectHistory({ threadId, projectId });

    const recovery = yield* ThreadRecoveryService;
    const outcome: RecoveryOutcome = yield* recovery.recover({
      threadId,
      cwd,
    });

    assert.equal(outcome._tag, "replay-with-transcript");
  }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: staleScanHome }))),
);

const forceReplayHome = makeClaudeHome();
it.live(
  "ThreadRecovery force db-replay: bypasses steps 1-4 even when a stored session_key would resolve",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-recovery-force");
      const projectId = ProjectId.make("project-recovery-force");
      const cwd = "/tmp/force-workspace";
      const sessionKey = "session-force-live";

      // A healthy session file that step 1 would normally resume.
      writeSessionFile(forceReplayHome, cwd, sessionKey);
      yield* seedProjectHistory({ threadId, projectId, sessionKey });

      // Seed messages so db-replay has something to render.
      yield* seedMessages(threadId, [
        { role: "user", text: "original question" },
        { role: "assistant", text: "original answer" },
      ]);

      const recovery = yield* ThreadRecoveryService;
      const outcome: RecoveryOutcome = yield* recovery.recover({
        threadId,
        cwd,
        force: "db-replay",
      });

      assert.equal(outcome._tag, "replay-with-transcript");
      if (outcome._tag === "replay-with-transcript") {
        assert.equal(outcome.messageCount, 2);
        assert.include(outcome.transcript, "original question");
        assert.include(outcome.transcript, "original answer");
      }
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: forceReplayHome }))),
);

const rehydrateFlagHome = makeClaudeHome();
it.live(
  "ThreadRecovery scheduleRehydrate/consumePendingRehydrate: one-shot read-and-clear semantics",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-recovery-rehydrate-flag");
      const otherThread = ThreadId.make("thread-recovery-rehydrate-other");

      const recovery = yield* ThreadRecoveryService;

      // Initially no flag set for either thread.
      const initial = yield* recovery.consumePendingRehydrate(threadId);
      assert.equal(initial, false);

      // Schedule only `threadId` — other thread must remain unaffected.
      yield* recovery.scheduleRehydrate(threadId);

      const otherPending = yield* recovery.consumePendingRehydrate(otherThread);
      assert.equal(otherPending, false);

      const firstConsume = yield* recovery.consumePendingRehydrate(threadId);
      assert.equal(firstConsume, true);

      // One-shot: second consume yields false.
      const secondConsume = yield* recovery.consumePendingRehydrate(threadId);
      assert.equal(secondConsume, false);
    }).pipe(Effect.provide(makeRecoveryLayer({ claudeHome: rehydrateFlagHome }))),
);
