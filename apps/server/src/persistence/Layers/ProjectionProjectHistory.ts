import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionProjectHistoryInput,
  ListProjectionProjectHistoryByProjectInput,
  ProjectionProjectHistory,
  ProjectionProjectHistoryRepository,
  type ProjectionProjectHistoryRepositoryShape,
  UpdateProjectionProjectHistoryFileReferenceInput,
  UpdateProjectionProjectHistorySessionKeyInput,
} from "../Services/ProjectionProjectHistory.ts";

const makeProjectionProjectHistoryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectHistoryRow = SqlSchema.void({
    Request: ProjectionProjectHistory,
    execute: (row) =>
      sql`
        INSERT INTO project_history (
          thread_id,
          project_id,
          session_key,
          file_reference,
          is_archived,
          is_deleted,
          created_at,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.sessionKey},
          ${row.fileReference},
          ${row.isArchived},
          ${row.isDeleted},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          session_key = excluded.session_key,
          file_reference = excluded.file_reference,
          is_archived = excluded.is_archived,
          is_deleted = excluded.is_deleted,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectHistoryRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectHistoryInput,
    Result: ProjectionProjectHistory,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          session_key AS "sessionKey",
          file_reference AS "fileReference",
          is_archived AS "isArchived",
          is_deleted AS "isDeleted",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_history
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectHistoryRows = SqlSchema.findAll({
    Request: ListProjectionProjectHistoryByProjectInput,
    Result: ProjectionProjectHistory,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          session_key AS "sessionKey",
          file_reference AS "fileReference",
          is_archived AS "isArchived",
          is_deleted AS "isDeleted",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_history
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const updateSessionKeyRow = SqlSchema.void({
    Request: UpdateProjectionProjectHistorySessionKeyInput,
    execute: ({ threadId, sessionKey, updatedAt }) =>
      sql`
        UPDATE project_history
        SET session_key = ${sessionKey},
            updated_at = ${updatedAt}
        WHERE thread_id = ${threadId}
      `,
  });

  const updateFileReferenceRow = SqlSchema.void({
    Request: UpdateProjectionProjectHistoryFileReferenceInput,
    execute: ({ threadId, fileReference, updatedAt }) =>
      sql`
        UPDATE project_history
        SET file_reference = ${fileReference},
            updated_at = ${updatedAt}
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionProjectHistoryRepositoryShape["upsert"] = (row) =>
    upsertProjectHistoryRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistoryRepository.upsert:query"),
      ),
    );

  const getById: ProjectionProjectHistoryRepositoryShape["getById"] = (input) =>
    getProjectHistoryRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistoryRepository.getById:query"),
      ),
    );

  const listByProjectId: ProjectionProjectHistoryRepositoryShape["listByProjectId"] = (input) =>
    listProjectHistoryRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistoryRepository.listByProjectId:query"),
      ),
    );

  const updateSessionKey: ProjectionProjectHistoryRepositoryShape["updateSessionKey"] = (input) =>
    updateSessionKeyRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistoryRepository.updateSessionKey:query"),
      ),
    );

  const updateFileReference: ProjectionProjectHistoryRepositoryShape["updateFileReference"] = (
    input,
  ) =>
    updateFileReferenceRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectHistoryRepository.updateFileReference:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    updateSessionKey,
    updateFileReference,
  } satisfies ProjectionProjectHistoryRepositoryShape;
});

export const ProjectionProjectHistoryRepositoryLive = Layer.effect(
  ProjectionProjectHistoryRepository,
  makeProjectionProjectHistoryRepository,
);
