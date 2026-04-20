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
 * Progress events are published on `streamEvents` so a UI overlay can
 * show the waterfall running in real time.
 *
 * @module ThreadRecoveryService
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

import type {
  ProviderAdapterProcessError,
  ProviderSessionDirectoryPersistenceError,
  ThreadRecoveryError,
} from "../Errors.ts";

/**
 * RecoveryStep - Identifier for each rung of the waterfall.
 *
 * Preserved verbatim on `RecoveryOutcome.step` and progress events, so
 * UI + telemetry can render human-readable labels without re-deriving
 * them.
 */
export type RecoveryStep =
  | "session-key"
  | "file-reference"
  | "scan-current-cwd"
  | "scan-all-cwds"
  | "db-replay";

/**
 * RecoveryOutcome.resumed - Waterfall found a live JSONL and produced a
 * Claude session id the caller can pass to `--resume`.
 *
 * `filePath` is the absolute path that was validated; the service also
 * writes this into `project_history.file_reference` so subsequent
 * recoveries short-circuit to step 2.
 */
export interface RecoveryOutcomeResumed {
  readonly _tag: "resumed";
  readonly step: RecoveryStep;
  readonly sessionKey: string;
  readonly filePath: string;
}

/**
 * RecoveryOutcome.replayWithTranscript - Waterfall could not resume the
 * original Claude session; caller should start a fresh Claude session
 * and feed `transcript` as the first user-turn content so the new
 * session has prior context.
 *
 * `messageCount` exists for UI telemetry ("Replayed 42 messages …").
 */
export interface RecoveryOutcomeReplayWithTranscript {
  readonly _tag: "replay-with-transcript";
  readonly step: "db-replay";
  readonly transcript: string;
  readonly messageCount: number;
}

/**
 * RecoveryOutcome.failed - Every step of the waterfall errored before
 * producing an outcome. In practice this only happens if the DB query
 * for step 5 fails (filesystem misconfiguration, sqlite corruption);
 * an empty thread still succeeds via `db-replay` with a zero-message
 * transcript.
 */
export interface RecoveryOutcomeFailed {
  readonly _tag: "failed";
  readonly attemptedSteps: ReadonlyArray<RecoveryStep>;
  readonly detail: string;
}

export type RecoveryOutcome =
  | RecoveryOutcomeResumed
  | RecoveryOutcomeReplayWithTranscript
  | RecoveryOutcomeFailed;

/**
 * RecoveryProgressEvent - Pushed onto the service's event stream as the
 * waterfall runs. Consumers filter by `_tag`.
 */
export type RecoveryProgressEvent =
  | { readonly _tag: "started"; readonly threadId: ThreadId; readonly cwd: string }
  | {
      readonly _tag: "step-started";
      readonly threadId: ThreadId;
      readonly step: RecoveryStep;
    }
  | {
      readonly _tag: "step-skipped";
      readonly threadId: ThreadId;
      readonly step: RecoveryStep;
      readonly reason: string;
    }
  | {
      readonly _tag: "step-succeeded";
      readonly threadId: ThreadId;
      readonly step: RecoveryStep;
      readonly detail: string;
    }
  | {
      readonly _tag: "step-failed";
      readonly threadId: ThreadId;
      readonly step: RecoveryStep;
      readonly reason: string;
    }
  | {
      readonly _tag: "completed";
      readonly threadId: ThreadId;
      readonly outcome: RecoveryOutcome;
    };

/**
 * RecoverInput - Minimal context the waterfall needs to operate.
 *
 * `claudeHome` is an optional override to make the scanning tests
 * hermetic (otherwise they'd hit `$HOME/.claude`). Production callers
 * omit it and get the default `$HOME/.claude`.
 */
export interface RecoverInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly claudeHome?: string;
}

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
  readonly recover: (
    input: RecoverInput,
  ) => Effect.Effect<RecoveryOutcome, ThreadRecoveryServiceError>;

  /**
   * Live stream of progress events across every in-flight `recover`
   * call. Consumers (RecoveryProgressOverlay) filter by `threadId` to
   * scope to a single recovery.
   */
  readonly streamEvents: Stream.Stream<RecoveryProgressEvent>;
}

export class ThreadRecoveryService extends Context.Service<
  ThreadRecoveryService,
  ThreadRecoveryShape
>()("t3/provider/Services/ThreadRecovery/ThreadRecoveryService") {}
