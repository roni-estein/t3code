import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `project_history_sessions` is an append-only audit/history table
  // that records every session_key a thread has ever been bound to.
  // Sibling to `project_history` (migration 027): the existing single
  // `project_history.session_key` column only retains the CURRENT key
  // and is overwritten on every imperative sync, which left two gaps
  // surfaced 2026-04-20:
  //
  //   1. CWD collision in ThreadRecovery steps 3 & 4. `scanCurrentCwd`
  //      and `scanAllCwds` enumerate JSONLs under the cwd-encoded
  //      directory and pick the newest. Claude CLI organises JSONLs
  //      by cwd, not by thread — so when two threads share a cwd
  //      (observed with #copy-writing a715587d and #HMR c96c5304 both
  //      in /mnt/dev/www/tachepharmacy) the scan could silently hand
  //      thread A back a JSONL belonging to thread B.
  //
  //   2. Session history loss on /compact. After a compact the
  //      provider mints a fresh CLI session; the imperative sync
  //      overwrites the prior key. There is no DB-resident way to
  //      re-resume from the pre-compact session key (or to audit the
  //      timeline of cuts).
  //
  // Columns rationale:
  //   thread_id       — permanent, branded UUID. Matches project_history.
  //   session_key     — the Claude CLI session ID (the value you'd pass
  //                     to `claude --resume <key>`). Many per thread.
  //   first_seen_at   — ISO-8601 timestamp of the first imperative
  //                     upsert that observed this (thread, session)
  //                     pair. Orders the timeline.
  //   superseded_at   — NULL means "currently active"; otherwise the
  //                     timestamp at which a later session_key took
  //                     over as the thread's active key. Append-only
  //                     semantics: a row's superseded_at is written at
  //                     most once and never cleared.
  //
  // Primary key (thread_id, session_key) makes `INSERT OR IGNORE` the
  // idempotency mechanism — the same (thread, session) pair can never
  // accumulate duplicate rows, and re-recording a key that is already
  // current is a no-op.
  //
  // idx_phs_session_key supports the waterfall's ownership filter:
  // given a JSONL's filename (its session_key), the scan steps must
  // answer "is this owned by a different thread?" in O(1).
  //
  // Maintained imperatively by ProviderSessionDirectory.upsert (same
  // hot path that already syncs project_history.session_key). Can be
  // rebuilt by replaying every prior resume_cursor value, but we do
  // not back-fill here — the history only matters for threads that
  // continue to be used after this migration lands, and back-filling
  // from a single-valued source would only produce one row per thread
  // (the current key), which the runtime will insert on next use
  // anyway.
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_history_sessions (
      thread_id     TEXT NOT NULL,
      session_key   TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      superseded_at TEXT,
      PRIMARY KEY (thread_id, session_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_phs_session_key
    ON project_history_sessions(session_key)
  `;
});
