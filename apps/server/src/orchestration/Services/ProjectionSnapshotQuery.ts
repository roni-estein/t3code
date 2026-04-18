/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  IsoDateTime,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/**
 * Caps applied to getThreadDetailById. When `messageLimit` is set, only the
 * most recent N messages (by created_at) are returned; likewise for
 * activities. Callers that need the full history should pass Infinity (or
 * omit the options to get the default — a safety cap rather than unbounded).
 */
export interface ProjectionThreadDetailWindow {
  readonly messageLimit?: number;
  readonly activityLimit?: number;
}

/**
 * Default caps used when a caller does not supply its own window. These are
 * tuned to keep the initial WebSocket payload small enough that the renderer
 * can deserialize it without V8 heap pressure on huge threads.
 */
export const DEFAULT_THREAD_DETAIL_WINDOW: Required<ProjectionThreadDetailWindow> = {
  messageLimit: 100,
  activityLimit: 500,
};

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   *
   * A `window` cap is applied to messages and activities to keep payload size
   * bounded. Pass `DEFAULT_THREAD_DETAIL_WINDOW` or a custom window; omitting
   * the argument applies the default.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
    window?: ProjectionThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Load a page of messages and activities strictly older than a given
   * created-at cursor. Used for scroll-up pagination after the initial
   * windowed getThreadDetailById payload.
   *
   * Returns messages in ascending chronological order (so callers can
   * prepend naturally) and the activities matching those turn windows.
   * `reachedStart` signals to the client that no further pages exist.
   */
  readonly listOlderThreadMessages: (input: {
    readonly threadId: ThreadId;
    readonly beforeCreatedAt: IsoDateTime;
    readonly limit: number;
  }) => Effect.Effect<
    {
      readonly messages: ReadonlyArray<OrchestrationMessage>;
      readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
      readonly reachedStart: boolean;
    },
    ProjectionRepositoryError
  >;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
