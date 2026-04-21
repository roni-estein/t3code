import { ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionProjectHistorySessionByKeyInput,
  GetProjectionProjectHistorySessionCurrentInput,
  ListProjectionProjectHistorySessionsByThreadInput,
  ProjectionProjectHistorySession,
  ProjectionProjectHistorySessionsRepository,
  RecordProjectionProjectHistorySessionInput,
  type ProjectionProjectHistorySessionsRepositoryShape,
} from "../Services/ProjectionProjectHistorySessions.ts";

// Intermediate schema used only for the `getThreadByKey` lookup. The
// public Service surface returns just the ThreadId — keeping the raw
// row schema private avoids leaking the column naming back out.
const ThreadIdRow = Schema.Struct({
  threadId: ThreadId,
});

const makeProjectionProjectHistorySessionsRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRowsByThreadQuery = SqlSchema.findAll({
    Request: ListProjectionProjectHistorySessionsByThreadInput,
    Result: ProjectionProjectHistorySession,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id     AS "threadId",
          session_key   AS "sessionKey",
          first_seen_at AS "firstSeenAt",
          superseded_at AS "supersededAt"
        FROM project_history_sessions
        WHERE thread_id = ${threadId}
        ORDER BY first_seen_at ASC, session_key ASC
      `,
  });

  const getThreadByKeyQuery = SqlSchema.findOneOption({
    Request: GetProjectionProjectHistorySessionByKeyInput,
    Result: ThreadIdRow,
    execute: ({ sessionKey }) =>
      sql`
        SELECT thread_id AS "threadId"
        FROM project_history_sessions
        WHERE session_key = ${sessionKey}
        LIMIT 1
      `,
  });

  const getCurrentByThreadIdQuery = SqlSchema.findOneOption({
    Request: GetProjectionProjectHistorySessionCurrentInput,
    Result: ProjectionProjectHistorySession,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id     AS "threadId",
          session_key   AS "sessionKey",
          first_seen_at AS "firstSeenAt",
          superseded_at AS "supersededAt"
        FROM project_history_sessions
        WHERE thread_id = ${threadId}
          AND superseded_at IS NULL
        LIMIT 1
      `,
  });

  /**
   * recordSession - Persist a (thread_id, session_key) pair as the
   * thread's current session, atomically superseding the prior
   * current row if the key has changed.
   *
   * The steps run inside a single `sql.withTransaction` so an
   * observer never sees two currently-active rows for the same
   * thread.
   *
   * Cases:
   *   (a) Row (thread, session_key) does not exist → insert as new
   *       current; supersede any prior current row atomically.
   *   (b) Row (thread, session_key) exists and is already current
   *       (superseded_at IS NULL) → no-op.
   *   (c) Row (thread, session_key) exists and is already superseded
   *       (superseded_at IS NOT NULL) → no-op. A re-record of a
   *       previously-superseded key almost certainly indicates an
   *       imperative-sync race with a stale resume_cursor; reviving
   *       it would corrupt the timeline AND would incorrectly mark
   *       the actual current row as superseded. Callers who need
   *       "resume from an older session" must go through a separate
   *       code path (not in this PR).
   *
   * We implement this with an explicit existence check rather than
   * bare `UPDATE ... WHERE session_key != X` because case (c) would
   * otherwise mark the real current row as superseded.
   */
  const recordSessionQuery = (input: RecordProjectionProjectHistorySessionInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<{
          readonly superseded_at: string | null;
        }>`
          SELECT superseded_at
          FROM project_history_sessions
          WHERE thread_id = ${input.threadId}
            AND session_key = ${input.sessionKey}
          LIMIT 1
        `;
        if (existing.length > 0) {
          // Cases (b) and (c) — row already exists, no-op.
          return;
        }
        // Case (a) — new (thread, session_key) pair. Supersede any
        // existing current row for this thread, then insert the new
        // current row.
        yield* sql`
          UPDATE project_history_sessions
          SET superseded_at = ${input.firstSeenAt}
          WHERE thread_id = ${input.threadId}
            AND superseded_at IS NULL
        `;
        yield* sql`
          INSERT INTO project_history_sessions (
            thread_id,
            session_key,
            first_seen_at,
            superseded_at
          ) VALUES (
            ${input.threadId},
            ${input.sessionKey},
            ${input.firstSeenAt},
            NULL
          )
        `;
      }),
    );

  const recordSession: ProjectionProjectHistorySessionsRepositoryShape["recordSession"] = (input) =>
    recordSessionQuery(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistorySessionsRepository.recordSession:query"),
      ),
      Effect.asVoid,
    );

  const listByThreadId: ProjectionProjectHistorySessionsRepositoryShape["listByThreadId"] = (
    input,
  ) =>
    listRowsByThreadQuery(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistorySessionsRepository.listByThreadId:query"),
      ),
    );

  const getThreadByKey: ProjectionProjectHistorySessionsRepositoryShape["getThreadByKey"] = (
    input,
  ) =>
    getThreadByKeyQuery(input).pipe(
      Effect.map(Option.map((row) => row.threadId)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistorySessionsRepository.getThreadByKey:query"),
      ),
    );

  const getCurrentByThreadId: ProjectionProjectHistorySessionsRepositoryShape["getCurrentByThreadId"] =
    (input) =>
      getCurrentByThreadIdQuery(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionProjectHistorySessionsRepository.getCurrentByThreadId:query",
          ),
        ),
      );

  return {
    recordSession,
    listByThreadId,
    getThreadByKey,
    getCurrentByThreadId,
  } satisfies ProjectionProjectHistorySessionsRepositoryShape;
});

export const ProjectionProjectHistorySessionsRepositoryLive = Layer.effect(
  ProjectionProjectHistorySessionsRepository,
  makeProjectionProjectHistorySessionsRepository,
);
