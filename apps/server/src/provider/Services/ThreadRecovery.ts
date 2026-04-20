/**
 * ThreadRecoveryService - Recovery waterfall for Claude threads whose
 * CLI session has become unreachable.
 *
 * Fires when a user asks to resume a thread and the Claude CLI's
 * `--resume <session_id>` would fail (missing JSONL, wrong cwd, stale
 * persistence). Runs a 5-step waterfall rooted in the
 * `project_history` recovery index (migration 027):
 *
 *   1. session-key     — use the stored `project_history.session_key`
 *                        (most-recent Claude resume token for this
 *                        thread, written imperatively by the provider
 *                        directory on every turn). Fast and O(1).
 *   2. file-reference  — use the stored `project_history.file_reference`
 *                        (cached absolute path to the known-good JSONL).
 *                        Populated lazily by the recovery service itself
 *                        after a successful recovery, so subsequent
 *                        attempts short-circuit to this step.
 *   3. scan-current-cwd — enumerate
 *                         `~/.claude/projects/<cwd-encoded>/*.jsonl`
 *                         and pick the newest within a freshness window.
 *                         Catches the common case where we lost the
 *                         session_key but the JSONL is still intact.
 *   4. scan-all-cwds    — enumerate every `~/.claude/projects/*` dir for
 *                         the newest JSONL. Catches the case where the
 *                         workspace root moved (cwd renamed) and the
 *                         original JSONL is parked under its old cwd
 *                         encoding.
 *   5. db-replay        — last resort: read the thread's projected
 *                         messages from sqlite and synthesise a
 *                         transcript that the caller can inject into a
 *                         fresh Claude session as the first user turn.
 *                         Always succeeds (even for an empty thread) —
 *                         this is the floor of the waterfall.
 *
 * Callers (e.g. ClaudeAdapter, the /recover-thread command) consume
 * the `RecoveryOutcome` tagged union and act on it:
 *   - `resumed`: pass `sessionKey` to `claude --resume`. Done.
 *   - `replay-with-transcript`: start a fresh session and prepend
 *     `transcript` as the first prompt. Claude sees prior context.
 *   - `failed`: surface the error to the user. Should be rare since
 *     step 5 is designed to always succeed for any existing thread.
 *
 * The Schemas for `RecoveryStep`, `RecoverInput`, `RecoveryOutcome`, and
 * `RecoveryProgressEvent` live in `@t3tools/contracts` because these
 * types cross the RPC boundary. This file is the server-facing service
 * contract that orchestrates the waterfall.
 *
 * @module ThreadRecoveryService
 */
import {
  type RecoverInput,
  type RecoveryOutcome,
  type RecoveryProgressEvent,
  type RecoveryStep,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

import type {
  ProviderAdapterProcessError,
  ProviderSessionDirectoryPersistenceError,
  ThreadRecoveryError,
} from "../Errors.ts";

// Re-export wire types so server-internal consumers don't need to reach
// across to @t3tools/contracts for them. Keeps the service's public
// surface self-contained.
export type { RecoverInput, RecoveryOutcome, RecoveryProgressEvent, RecoveryStep };

/**
 * Errors that the service itself can raise. `ThreadRecoveryError` is the
 * terminal "we couldn't help you" failure; the other two are bubbled up
 * from dependencies (provider directory reads, projection reads) and
 * indicate an infrastructure issue rather than a missing session.
 */
export type ThreadRecoveryServiceError =
  | ThreadRecoveryError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterProcessError;

export interface ThreadRecoveryShape {
  /**
   * One-shot recovery. Runs the waterfall, publishes progress events
   * on `streamEvents`, and returns the terminal outcome.
   *
   * Used by the ClaudeAdapter when a `--resume` attempt fails: it just
   * needs to know whether to retry with a different session id or start
   * fresh with a replay transcript.
   */
  readonly recover: (
    input: RecoverInput,
  ) => Effect.Effect<RecoveryOutcome, ThreadRecoveryServiceError>;

  /**
   * Streaming recovery. Internally invokes `recover` while relaying
   * progress events scoped to this `threadId` to the returned stream.
   * The stream terminates at the `completed` event, which always
   * carries the final `outcome`.
   *
   * Used by the `threadRecovery.recover` RPC so the UI overlay can
   * render the waterfall running in real time.
   *
   * Handles the subscribe-before-publish race internally so no events
   * are missed between subscription and the first `started` event.
   */
  readonly recoverStream: (
    input: RecoverInput,
  ) => Stream.Stream<RecoveryProgressEvent, ThreadRecoveryServiceError>;

  /**
   * Live firehose of progress events across every in-flight `recover`
   * call. Exposed for telemetry sinks and tests; most consumers want
   * `recoverStream` instead.
   */
  readonly streamEvents: Stream.Stream<RecoveryProgressEvent>;
}

export class ThreadRecoveryService extends Context.Service<
  ThreadRecoveryService,
  ThreadRecoveryShape
>()("t3/provider/Services/ThreadRecovery/ThreadRecoveryService") {}
