/**
 * ProjectionProjectHistorySessionsRepository - Repository interface
 * for the `project_history_sessions` append-only session history index.
 *
 * Sibling to `ProjectionProjectHistoryRepository`. While
 * `project_history` carries only a single current `session_key` per
 * thread (overwritten on every imperative sync), this table retains
 * the full lineage: every (thread_id, session_key) pair the provider
 * has ever observed, with first_seen_at + superseded_at to establish
 * chronological order.
 *
 * See migration 029 for full rationale. Two primary consumers:
 *
 *   1. `ProviderSessionDirectory.upsert` — writes new rows on every
 *      resume_cursor advance so the history is always current.
 *   2. `ThreadRecoveryService` (steps 3 & 4 of the waterfall) — calls
 *      `getThreadByKey` to answer "is this JSONL owned by a different
 *      thread?" before accepting a candidate JSONL from a cwd scan.
 *
 * @module ProjectionProjectHistorySessionsRepository
 */
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProjectHistorySession = Schema.Struct({
  threadId: ThreadId,
  sessionKey: Schema.String,
  firstSeenAt: IsoDateTime,
  supersededAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProjectHistorySession = typeof ProjectionProjectHistorySession.Type;

export const RecordProjectionProjectHistorySessionInput = Schema.Struct({
  threadId: ThreadId,
  sessionKey: Schema.String,
  firstSeenAt: IsoDateTime,
});
export type RecordProjectionProjectHistorySessionInput =
  typeof RecordProjectionProjectHistorySessionInput.Type;

export const ListProjectionProjectHistorySessionsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionProjectHistorySessionsByThreadInput =
  typeof ListProjectionProjectHistorySessionsByThreadInput.Type;

export const GetProjectionProjectHistorySessionByKeyInput = Schema.Struct({
  sessionKey: Schema.String,
});
export type GetProjectionProjectHistorySessionByKeyInput =
  typeof GetProjectionProjectHistorySessionByKeyInput.Type;

export const GetProjectionProjectHistorySessionCurrentInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionProjectHistorySessionCurrentInput =
  typeof GetProjectionProjectHistorySessionCurrentInput.Type;

/**
 * ProjectionProjectHistorySessionsRepositoryShape - Service API for
 * the session-history sibling index.
 */
export interface ProjectionProjectHistorySessionsRepositoryShape {
  /**
   * Record a (thread_id, session_key) pair as the thread's current
   * session.
   *
   * Semantics:
   *   - Idempotent on the pair: inserting the same (thread, session)
   *     twice is a no-op. The timestamp of the first write is
   *     preserved (the row's superseded_at, if already set, is left
   *     alone — re-recording a superseded key does NOT revive it).
   *   - If the pair is NEW (or is already current) AND it differs
   *     from the thread's current session, the thread's prior current
   *     row is updated: its `superseded_at` is set to `firstSeenAt`.
   *     This preserves append-only semantics (a row is never
   *     deleted and its superseded_at is written at most once).
   *   - Atomic: both writes happen in a single transaction so the
   *     thread never has two currently-active rows concurrently.
   */
  readonly recordSession: (
    input: RecordProjectionProjectHistorySessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List every session_key ever recorded for a thread, ordered by
   * first_seen_at ASC (oldest first). Includes superseded rows so
   * callers can render the full /compact timeline.
   */
  readonly listByThreadId: (
    input: ListProjectionProjectHistorySessionsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionProjectHistorySession>, ProjectionRepositoryError>;

  /**
   * Reverse lookup: given a session_key, return the thread_id that
   * owns it. Used by the ThreadRecovery waterfall's cwd-scan steps
   * as an ownership filter.
   *
   * Returns `Option.none()` if the session_key has never been
   * recorded (the waterfall treats that as "new/uncatalogued — accept
   * the JSONL").
   *
   * Indexed by `idx_phs_session_key` → O(1). A given session_key
   * SHOULD only ever be bound to one thread_id (Claude CLI mints a
   * fresh session id for each thread), but the primary key technically
   * permits duplicates across threads; this query returns the first
   * match, which is sufficient for the "is it mine or someone else's?"
   * question.
   */
  readonly getThreadByKey: (
    input: GetProjectionProjectHistorySessionByKeyInput,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Return the currently-active session row for a thread (the one
   * with `superseded_at IS NULL`), if any.
   */
  readonly getCurrentByThreadId: (
    input: GetProjectionProjectHistorySessionCurrentInput,
  ) => Effect.Effect<Option.Option<ProjectionProjectHistorySession>, ProjectionRepositoryError>;
}

/**
 * ProjectionProjectHistorySessionsRepository - Service tag for the
 * session-history sibling index.
 */
export class ProjectionProjectHistorySessionsRepository extends Context.Service<
  ProjectionProjectHistorySessionsRepository,
  ProjectionProjectHistorySessionsRepositoryShape
>()(
  "t3/persistence/Services/ProjectionProjectHistorySessions/ProjectionProjectHistorySessionsRepository",
) {}
