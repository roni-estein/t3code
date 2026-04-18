import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Disaster-recovery mirror of Claude Code's per-session jsonl. When a
  // session ends (or periodically, if we want continuous capture later),
  // we stash the raw bytes of `~/.claude/projects/<cwd-encoded>/<id>.jsonl`
  // here. If the on-disk file is ever lost (t3-serve restart mid-write,
  // crash, GC, disk loss, machine swap), we can restore it byte-for-byte
  // and resume from the Claude CLI's perspective without recomputing
  // context.
  //
  // Keyed by (thread_id, provider_session_id) — multiple sessions per
  // thread accumulate over time. `captured_at` + a triggering sequence
  // lets newer captures supersede older ones for the same session_id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS claude_session_blobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      blob BLOB NOT NULL,
      captured_at TEXT NOT NULL,
      UNIQUE(thread_id, provider_session_id, captured_at)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_claude_session_blobs_latest
    ON claude_session_blobs(thread_id, provider_session_id, captured_at DESC)
  `;
});
