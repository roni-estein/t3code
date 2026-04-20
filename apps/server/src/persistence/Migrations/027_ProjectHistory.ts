import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `project_history` is the recovery index for every thread the user has
  // ever created in a project. It is the single source of truth that the
  // ThreadRecoveryService pivots off of when a thread fails to activate
  // (session_key invalid, jsonl missing, provider unreachable, etc).
  //
  // Columns rationale:
  //   thread_id      — permanent, branded UUID; never rewritten by any code path
  //                    (verified: no UPDATE ... SET thread_id exists anywhere).
  //   project_id     — permanent, the owning project.
  //   session_key    — mutable. Claude's provider_session_id; rotates every
  //                    time we rebuild from projections (STEP 2 of waterfall).
  //   file_reference — mutable. Absolute path to the Claude jsonl. Computed
  //                    lazily from (cwd, session_key) via
  //                    resolveClaudeSessionFilePath; stored denormalized so
  //                    step 3/4 of the waterfall can look it up without
  //                    re-joining projection_projects.
  //   is_archived    — boolean flag mirroring projection_threads.archived_at.
  //   is_deleted     — boolean flag mirroring projection_threads.deleted_at.
  //   created_at /
  //   updated_at     — index bookkeeping.
  //
  // The table is a PROJECTION — maintained by the projection handlers in
  // response to orchestration events (ThreadCreated, SessionBound,
  // SessionRotated, ThreadArchived, ThreadDeleted). It can be fully
  // rebuilt from the orchestration_events store if corrupted.
  //
  // Supersedes claude_session_blobs (dropped in migration 028).
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_history (
      thread_id      TEXT    PRIMARY KEY,
      project_id     TEXT    NOT NULL,
      session_key    TEXT,
      file_reference TEXT,
      is_archived    INTEGER NOT NULL DEFAULT 0,
      is_deleted     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL,
      updated_at     TEXT    NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_history_project
    ON project_history(project_id, is_deleted, is_archived)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_history_session
    ON project_history(session_key)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_history_file_reference
    ON project_history(file_reference)
  `;

  // Backfill from existing projection_threads + projection_thread_sessions.
  //
  // file_reference is intentionally left NULL here — migrations are pure SQL
  // and should not touch the filesystem. The ThreadRecoveryService (or the
  // projection handler on first activation) computes the expected path from
  // (projection_projects.workspace_root, projection_thread_sessions.provider_session_id)
  // via resolveClaudeSessionFilePath and populates the row on demand.
  //
  // INSERT OR IGNORE protects against the (rare) case where a projection
  // handler has already been deployed and pre-populated this table in a
  // prior partial rollout.
  yield* sql`
    INSERT OR IGNORE INTO project_history (
      thread_id,
      project_id,
      session_key,
      file_reference,
      is_archived,
      is_deleted,
      created_at,
      updated_at
    )
    SELECT
      t.thread_id,
      t.project_id,
      s.provider_session_id,
      NULL,
      CASE WHEN t.archived_at IS NOT NULL THEN 1 ELSE 0 END,
      CASE WHEN t.deleted_at  IS NOT NULL THEN 1 ELSE 0 END,
      t.created_at,
      t.updated_at
    FROM projection_threads t
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
  `;
});
