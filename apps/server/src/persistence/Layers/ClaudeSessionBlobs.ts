import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ClaudeSessionBlobRepositoryError,
} from "../Errors.ts";
import {
  CaptureClaudeSessionBlobInput,
  ClaudeSessionBlobRecord,
  ClaudeSessionBlobRepository,
  type ClaudeSessionBlobRepositoryShape,
  GetLatestClaudeSessionBlobInput,
  ListClaudeSessionBlobsInput,
  PruneClaudeSessionBlobsInput,
} from "../Services/ClaudeSessionBlobs.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ClaudeSessionBlobRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const SELECT_COLUMNS = `
  id AS "id",
  thread_id AS "threadId",
  provider_session_id AS "providerSessionId",
  cwd AS "cwd",
  byte_length AS "byteLength",
  blob AS "blob",
  captured_at AS "capturedAt"
`;

const makeClaudeSessionBlobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const captureBlob = SqlSchema.void({
    Request: CaptureClaudeSessionBlobInput,
    execute: (input) =>
      sql`
        INSERT INTO claude_session_blobs (
          thread_id,
          provider_session_id,
          cwd,
          byte_length,
          blob,
          captured_at
        )
        VALUES (
          ${input.threadId},
          ${input.providerSessionId},
          ${input.cwd},
          ${input.blob.byteLength},
          ${input.blob},
          ${input.capturedAt}
        )
      `,
  });

  const getLatestRow = SqlSchema.findOneOption({
    Request: GetLatestClaudeSessionBlobInput,
    Result: ClaudeSessionBlobRecord,
    execute: ({ threadId, providerSessionId }) =>
      sql`
        SELECT ${sql.unsafe(SELECT_COLUMNS)}
        FROM claude_session_blobs
        WHERE thread_id = ${threadId}
          AND provider_session_id = ${providerSessionId}
        ORDER BY captured_at DESC, id DESC
        LIMIT 1
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListClaudeSessionBlobsInput,
    Result: ClaudeSessionBlobRecord,
    execute: ({ threadId }) =>
      sql`
        SELECT ${sql.unsafe(SELECT_COLUMNS)}
        FROM claude_session_blobs
        WHERE thread_id = ${threadId}
        ORDER BY captured_at DESC, id DESC
      `,
  });

  const pruneRows = SqlSchema.findAll({
    Request: PruneClaudeSessionBlobsInput,
    Result: Schema.Struct({ id: Schema.Int }),
    execute: ({ threadId, providerSessionId, keep }) =>
      sql`
        DELETE FROM claude_session_blobs
        WHERE thread_id = ${threadId}
          AND provider_session_id = ${providerSessionId}
          AND id NOT IN (
            SELECT id FROM claude_session_blobs
            WHERE thread_id = ${threadId}
              AND provider_session_id = ${providerSessionId}
            ORDER BY captured_at DESC, id DESC
            LIMIT ${keep}
          )
        RETURNING id AS "id"
      `,
  });

  const capture: ClaudeSessionBlobRepositoryShape["capture"] = (input) =>
    captureBlob(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ClaudeSessionBlobRepository.capture:query",
          "ClaudeSessionBlobRepository.capture:encodeRequest",
        ),
      ),
    );

  const getLatest: ClaudeSessionBlobRepositoryShape["getLatest"] = (input) =>
    getLatestRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ClaudeSessionBlobRepository.getLatest:query",
          "ClaudeSessionBlobRepository.getLatest:decodeRow",
        ),
      ),
    );

  const list: ClaudeSessionBlobRepositoryShape["list"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ClaudeSessionBlobRepository.list:query",
          "ClaudeSessionBlobRepository.list:decodeRows",
        ),
      ),
    );

  const prune: ClaudeSessionBlobRepositoryShape["prune"] = (input) =>
    pruneRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ClaudeSessionBlobRepository.prune:query",
          "ClaudeSessionBlobRepository.prune:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length),
    );

  return {
    capture,
    getLatest,
    list,
    prune,
  } satisfies ClaudeSessionBlobRepositoryShape;
});

export const ClaudeSessionBlobRepositoryLive = Layer.effect(
  ClaudeSessionBlobRepository,
  makeClaudeSessionBlobRepository,
);
