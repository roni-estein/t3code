import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionProjectHistorySessionsRepository } from "../Services/ProjectionProjectHistorySessions.ts";
import { ProjectionProjectHistorySessionsRepositoryLive } from "./ProjectionProjectHistorySessions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionProjectHistorySessionsRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionProjectHistorySessionsRepository", (it) => {
  it.effect("records a new session and exposes it via getCurrentByThreadId", () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionProjectHistorySessionsRepository;
      const threadId = ThreadId.make("thread-record-new");
      const firstSeenAt = IsoDateTime.make("2026-04-20T12:00:00.000Z");

      yield* repo.recordSession({
        threadId,
        sessionKey: "session-alpha",
        firstSeenAt,
      });

      const current = yield* repo.getCurrentByThreadId({ threadId });
      assert.equal(Option.isSome(current), true);
      if (Option.isSome(current)) {
        assert.equal(current.value.threadId, threadId);
        assert.equal(current.value.sessionKey, "session-alpha");
        assert.equal(current.value.firstSeenAt, firstSeenAt);
        assert.equal(current.value.supersededAt, null);
      }

      const history = yield* repo.listByThreadId({ threadId });
      assert.equal(history.length, 1);
      assert.equal(history[0]?.sessionKey, "session-alpha");
    }),
  );

  it.effect("supersedes prior current row when session_key advances", () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionProjectHistorySessionsRepository;
      const threadId = ThreadId.make("thread-advance-chain");

      const t1 = IsoDateTime.make("2026-04-20T12:00:00.000Z");
      const t2 = IsoDateTime.make("2026-04-20T12:05:00.000Z");
      const t3 = IsoDateTime.make("2026-04-20T12:10:00.000Z");

      yield* repo.recordSession({ threadId, sessionKey: "sess-1", firstSeenAt: t1 });
      yield* repo.recordSession({ threadId, sessionKey: "sess-2", firstSeenAt: t2 });
      yield* repo.recordSession({ threadId, sessionKey: "sess-3", firstSeenAt: t3 });

      const history = yield* repo.listByThreadId({ threadId });
      assert.equal(history.length, 3);
      // Ordered by first_seen_at ascending.
      assert.equal(history[0]?.sessionKey, "sess-1");
      assert.equal(history[1]?.sessionKey, "sess-2");
      assert.equal(history[2]?.sessionKey, "sess-3");

      // sess-1 and sess-2 are superseded; sess-3 is current.
      assert.equal(history[0]?.supersededAt, t2);
      assert.equal(history[1]?.supersededAt, t3);
      assert.equal(history[2]?.supersededAt, null);

      const current = yield* repo.getCurrentByThreadId({ threadId });
      assert.equal(Option.isSome(current), true);
      if (Option.isSome(current)) {
        assert.equal(current.value.sessionKey, "sess-3");
      }
    }),
  );

  it.effect("is idempotent when re-recording the already-current session_key", () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionProjectHistorySessionsRepository;
      const threadId = ThreadId.make("thread-idempotent-current");

      const t1 = IsoDateTime.make("2026-04-20T12:00:00.000Z");
      const t2 = IsoDateTime.make("2026-04-20T12:05:00.000Z");

      yield* repo.recordSession({ threadId, sessionKey: "sess-only", firstSeenAt: t1 });
      // Re-record the same pair at a later timestamp. Expected:
      // existence check returns the existing row → no-op.
      yield* repo.recordSession({ threadId, sessionKey: "sess-only", firstSeenAt: t2 });

      const history = yield* repo.listByThreadId({ threadId });
      assert.equal(history.length, 1);
      assert.equal(history[0]?.sessionKey, "sess-only");
      assert.equal(history[0]?.firstSeenAt, t1); // original timestamp preserved
      assert.equal(history[0]?.supersededAt, null); // still current
    }),
  );

  it.effect("does not revive a previously-superseded session_key", () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionProjectHistorySessionsRepository;
      const threadId = ThreadId.make("thread-no-revive");

      const t1 = IsoDateTime.make("2026-04-20T12:00:00.000Z");
      const t2 = IsoDateTime.make("2026-04-20T12:05:00.000Z");
      const t3 = IsoDateTime.make("2026-04-20T12:10:00.000Z");

      yield* repo.recordSession({ threadId, sessionKey: "sess-old", firstSeenAt: t1 });
      yield* repo.recordSession({ threadId, sessionKey: "sess-new", firstSeenAt: t2 });
      // A stale imperative sync attempts to re-record sess-old. Must
      // not clobber sess-new's current-row status.
      yield* repo.recordSession({ threadId, sessionKey: "sess-old", firstSeenAt: t3 });

      const current = yield* repo.getCurrentByThreadId({ threadId });
      assert.equal(Option.isSome(current), true);
      if (Option.isSome(current)) {
        assert.equal(current.value.sessionKey, "sess-new");
      }

      const history = yield* repo.listByThreadId({ threadId });
      assert.equal(history.length, 2);
      const old = history.find((r) => r.sessionKey === "sess-old");
      assert.equal(old?.supersededAt, t2);
    }),
  );

  it.effect("getThreadByKey returns the owning thread for a known session_key", () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionProjectHistorySessionsRepository;
      const threadA = ThreadId.make("thread-lookup-a");
      const threadB = ThreadId.make("thread-lookup-b");
      const t = IsoDateTime.make("2026-04-20T12:00:00.000Z");

      yield* repo.recordSession({ threadId: threadA, sessionKey: "sess-a", firstSeenAt: t });
      yield* repo.recordSession({ threadId: threadB, sessionKey: "sess-b", firstSeenAt: t });

      const ownerA = yield* repo.getThreadByKey({ sessionKey: "sess-a" });
      assert.equal(Option.isSome(ownerA), true);
      if (Option.isSome(ownerA)) {
        assert.equal(ownerA.value, threadA);
      }

      const ownerB = yield* repo.getThreadByKey({ sessionKey: "sess-b" });
      assert.equal(Option.isSome(ownerB), true);
      if (Option.isSome(ownerB)) {
        assert.equal(ownerB.value, threadB);
      }

      const unknown = yield* repo.getThreadByKey({ sessionKey: "sess-unknown" });
      assert.equal(Option.isNone(unknown), true);
    }),
  );
});
