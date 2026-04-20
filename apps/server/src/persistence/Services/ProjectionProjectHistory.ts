/**
 * ProjectionProjectHistoryRepository - Repository interface for
 * the project_history recovery index.
 *
 * project_history is the denormalized index the ThreadRecoveryService
 * pivots off of when a thread fails to activate (session_key invalid,
 * jsonl missing, provider unreachable, etc). See migration 027 for the
 * full rationale.
 *
 * @module ProjectionProjectHistoryRepository
 */
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProjectHistory = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  sessionKey: Schema.NullOr(Schema.String),
  fileReference: Schema.NullOr(Schema.String),
  isArchived: NonNegativeInt,
  isDeleted: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionProjectHistory = typeof ProjectionProjectHistory.Type;

export const GetProjectionProjectHistoryInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionProjectHistoryInput = typeof GetProjectionProjectHistoryInput.Type;

export const ListProjectionProjectHistoryByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionProjectHistoryByProjectInput =
  typeof ListProjectionProjectHistoryByProjectInput.Type;

export const UpdateProjectionProjectHistorySessionKeyInput = Schema.Struct({
  threadId: ThreadId,
  sessionKey: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdateProjectionProjectHistorySessionKeyInput =
  typeof UpdateProjectionProjectHistorySessionKeyInput.Type;

export const UpdateProjectionProjectHistoryFileReferenceInput = Schema.Struct({
  threadId: ThreadId,
  fileReference: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdateProjectionProjectHistoryFileReferenceInput =
  typeof UpdateProjectionProjectHistoryFileReferenceInput.Type;

/**
 * ProjectionProjectHistoryRepositoryShape - Service API for the
 * project_history recovery index.
 */
export interface ProjectionProjectHistoryRepositoryShape {
  /**
   * Insert or replace a project_history row.
   *
   * Upserts by `threadId`. Projector handlers use this after reading
   * the current row via `getById` to carry forward unchanged fields
   * (matching the pattern used throughout ProjectionPipeline).
   */
  readonly upsert: (
    row: ProjectionProjectHistory,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a single project_history row by thread id.
   */
  readonly getById: (
    input: GetProjectionProjectHistoryInput,
  ) => Effect.Effect<Option.Option<ProjectionProjectHistory>, ProjectionRepositoryError>;

  /**
   * List all project_history rows for a project (used by the recovery
   * waterfall's step 1 enumeration).
   *
   * Ordered by `createdAt ASC, threadId ASC` for deterministic UX.
   * Includes archived + soft-deleted rows — the caller decides which
   * to show.
   */
  readonly listByProjectId: (
    input: ListProjectionProjectHistoryByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionProjectHistory>, ProjectionRepositoryError>;

  /**
   * Partial update — rotate only the session_key + updated_at.
   *
   * Called from the ProviderSessionDirectory.upsert path when the
   * Claude CLI hands us a fresh resume token. Leaves is_archived /
   * is_deleted / file_reference untouched (those belong to separate
   * state machines and would be clobbered by a full-row upsert).
   *
   * No-op if the row does not exist yet (projector handlers own row
   * creation on thread.created).
   */
  readonly updateSessionKey: (
    input: UpdateProjectionProjectHistorySessionKeyInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Partial update — rotate only the file_reference + updated_at.
   *
   * Called from the ThreadRecoveryService after it computes the
   * expected jsonl path from `(cwd, session_key)` via
   * `resolveClaudeSessionFilePath`. Leaves is_archived / is_deleted /
   * session_key untouched.
   *
   * No-op if the row does not exist yet.
   */
  readonly updateFileReference: (
    input: UpdateProjectionProjectHistoryFileReferenceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionProjectHistoryRepository - Service tag for the
 * project_history recovery index.
 */
export class ProjectionProjectHistoryRepository extends Context.Service<
  ProjectionProjectHistoryRepository,
  ProjectionProjectHistoryRepositoryShape
>()(
  "t3/persistence/Services/ProjectionProjectHistory/ProjectionProjectHistoryRepository",
) {}
