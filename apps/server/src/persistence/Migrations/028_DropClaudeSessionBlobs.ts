import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Drop `claude_session_blobs` (introduced in migration 026). The
  // byte-for-byte blob-restoration direction was superseded by the
  // project_history-based recovery waterfall (migration 027 +
  // ThreadRecoveryService). Raw blob capture was never wired into any
  // layer at runtime — this table has always been empty — so the drop
  // is harmless in practice, but we remove it to keep the schema honest.
  //
  // The matching Layers/ClaudeSessionBlobs.ts + Services/ClaudeSessionBlobs.ts
  // files are deleted in the same commit.
  yield* sql`DROP INDEX IF EXISTS idx_claude_session_blobs_latest`;
  yield* sql`DROP TABLE IF EXISTS claude_session_blobs`;
});
