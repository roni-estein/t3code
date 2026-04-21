/**
 * ThreadRecoveryLive - Implementation of the 5-step Claude thread
 * recovery waterfall.
 *
 * See `../Services/ThreadRecovery.ts` for the full rationale and the
 * definition of each step. This file is the runtime: reads
 * project_history, walks the filesystem, synthesises transcripts, and
 * publishes progress events.
 *
 * Filesystem access uses `node:fs/promises` directly (matching
 * `sessionHealth.ts`) rather than Effect's FileSystem. That's
 * deliberate: tests point `claudeHome` at a temp directory created via
 * `fs.mkdtempSync`, which keeps the fixture hermetic without needing a
 * mock FS layer.
 *
 * @module ThreadRecoveryLive
 */
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import { IsoDateTime, type ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, PubSub, Stream } from "effect";

import { ProjectionProjectHistoryRepository } from "../../persistence/Services/ProjectionProjectHistory.ts";
import { ProjectionProjectHistorySessionsRepository } from "../../persistence/Services/ProjectionProjectHistorySessions.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProviderSessionDirectoryPersistenceError, ThreadRecoveryError } from "../Errors.ts";
import { encodeCwdForClaudeProjects, resolveClaudeSessionFilePath } from "../sessionHealth.ts";
import {
  type RecoverInput,
  type RecoveryOutcome,
  type RecoveryProgressEvent,
  type RecoveryStep,
  ThreadRecoveryService,
  type ThreadRecoveryShape,
} from "../Services/ThreadRecovery.ts";

/**
 * Freshness window for the filesystem-scan steps (3 and 4).
 *
 * JSONL files older than this are ignored. Rationale: if a session's
 * last activity was more than a week ago the user has almost certainly
 * moved on, and silently resuming ancient context would be more
 * confusing than starting fresh with the DB transcript.
 *
 * Tunable via the `freshnessWindowMs` option on the Live factory.
 */
const DEFAULT_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ThreadRecoveryLiveOptions {
  /**
   * Absolute path to Claude's config root (contains `projects/`).
   * Defaults to `$HOME/.claude`.
   */
  readonly claudeHome?: string;

  /**
   * Filesystem-scan freshness window in ms. Defaults to 7 days.
   */
  readonly freshnessWindowMs?: number;

  /**
   * Max transcript characters emitted by step 5. Prevents the fresh
   * session's first prompt from exceeding Claude's input limits on
   * long threads. Defaults to 100_000 (~25k tokens).
   */
  readonly maxTranscriptChars?: number;
}

function resolveClaudeHome(override?: string): string {
  return override ?? Path.join(Os.homedir(), ".claude");
}

/**
 * readJsonlCandidates - Enumerate `*.jsonl` files under `dir`,
 * returning each file's absolute path, mtime, and inferred session id
 * (filename without extension).
 *
 * Errors during enumeration are swallowed: a missing or unreadable
 * directory just yields an empty list, which is the right behaviour
 * for the recovery waterfall (skip the step, try the next one).
 */
async function readJsonlCandidates(dir: string): Promise<
  ReadonlyArray<{
    readonly sessionId: string;
    readonly filePath: string;
    readonly mtimeMs: number;
    readonly sizeBytes: number;
  }>
> {
  let entries: ReadonlyArray<string>;
  try {
    entries = await Fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{
    readonly sessionId: string;
    readonly filePath: string;
    readonly mtimeMs: number;
    readonly sizeBytes: number;
  }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    const filePath = Path.join(dir, entry);
    try {
      const stat = await Fs.stat(filePath);
      if (!stat.isFile() || stat.size === 0) {
        continue;
      }
      out.push({
        sessionId: entry.slice(0, -".jsonl".length),
        filePath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * readProjectDirs - Enumerate subdirectories under `<claudeHome>/projects`.
 * Each directory corresponds to one cwd-encoded path.
 */
async function readProjectDirs(claudeHome: string): Promise<ReadonlyArray<string>> {
  const projectsRoot = Path.join(claudeHome, "projects");
  let entries: ReadonlyArray<string>;
  try {
    entries = await Fs.readdir(projectsRoot);
  } catch {
    return [];
  }
  const dirs: Array<string> = [];
  for (const entry of entries) {
    const full = Path.join(projectsRoot, entry);
    try {
      const stat = await Fs.stat(full);
      if (stat.isDirectory()) {
        dirs.push(full);
      }
    } catch {
      continue;
    }
  }
  return dirs;
}

/**
 * claudeSessionFileIsUsable - Validate that the given session file
 * exists and is non-empty.
 *
 * Used at the top of steps 1 and 2 to confirm a stored pointer is
 * still live before we hand it to `--resume`.
 */
async function claudeSessionFileIsUsable(filePath: string): Promise<boolean> {
  try {
    const stat = await Fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

const STEP_ORDER: ReadonlyArray<RecoveryStep> = [
  "session-key",
  "file-reference",
  "scan-current-cwd",
  "scan-all-cwds",
  "db-replay",
] as const;

/**
 * renderTranscript - Build the human-readable transcript the caller
 * will inject as the first user prompt of a fresh Claude session.
 *
 * Keeps the rendering dead simple ("User: …\nAssistant: …") rather than
 * trying to reconstruct the Claude CLI's internal JSONL format —
 * Claude doesn't need to parse this back into its conversation state,
 * it just needs enough prior context to continue the thread sensibly.
 *
 * If rendering exceeds `maxChars`, the oldest messages are truncated
 * and a leading "[…earlier conversation truncated…]" marker is
 * inserted.
 */
function renderTranscript(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
  maxChars: number,
): string {
  const formatted = messages.map((m) => {
    const label = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
    return `${label}: ${m.text}`;
  });
  let joined = formatted.join("\n\n");
  if (joined.length <= maxChars) {
    return joined;
  }
  const marker = "[…earlier conversation truncated…]\n\n";
  // Drop messages from the front until we're within budget.
  let budget = maxChars - marker.length;
  const kept: Array<string> = [];
  for (let i = formatted.length - 1; i >= 0; i -= 1) {
    const piece = formatted[i]!;
    const pieceLen = piece.length + 2; // +2 for "\n\n"
    if (budget - pieceLen < 0) {
      break;
    }
    budget -= pieceLen;
    kept.unshift(piece);
  }
  joined = marker + kept.join("\n\n");
  return joined;
}

const makeThreadRecovery = (options?: ThreadRecoveryLiveOptions) =>
  Effect.gen(function* () {
    const projectHistoryRepository = yield* ProjectionProjectHistoryRepository;
    const projectHistorySessionsRepository = yield* ProjectionProjectHistorySessionsRepository;
    const threadMessageRepository = yield* ProjectionThreadMessageRepository;

    const defaultClaudeHome = options?.claudeHome;
    const freshnessWindowMs = Math.max(
      0,
      options?.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS,
    );
    const maxTranscriptChars = Math.max(1024, options?.maxTranscriptChars ?? 100_000);

    const pubsub = yield* PubSub.unbounded<RecoveryProgressEvent>();

    /**
     * Set of thread ids flagged for forced db-replay via
     * `scheduleRehydrate`. Consumed once by `consumePendingRehydrate`.
     * In-memory only — see `ThreadRecoveryShape.scheduleRehydrate`
     * docstring for the rationale.
     */
    const pendingRehydrate = new Set<ThreadId>();

    const emit = (event: RecoveryProgressEvent) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);

    const emitStarted = (threadId: ThreadId, cwd: string) =>
      emit({ _tag: "started", threadId, cwd });
    const emitStepStarted = (threadId: ThreadId, step: RecoveryStep) =>
      emit({ _tag: "step-started", threadId, step });
    const emitStepSkipped = (threadId: ThreadId, step: RecoveryStep, reason: string) =>
      emit({ _tag: "step-skipped", threadId, step, reason });
    const emitStepSucceeded = (threadId: ThreadId, step: RecoveryStep, detail: string) =>
      emit({ _tag: "step-succeeded", threadId, step, detail });
    const emitStepFailed = (threadId: ThreadId, step: RecoveryStep, reason: string) =>
      emit({ _tag: "step-failed", threadId, step, reason });
    const emitCompleted = (threadId: ThreadId, outcome: RecoveryOutcome) =>
      emit({ _tag: "completed", threadId, outcome });

    /**
     * cachedFileReference - Update project_history.file_reference after a
     * successful filesystem-scan recovery so subsequent recoveries
     * short-circuit to step 2.
     */
    const cachedFileReference = (threadId: ThreadId, filePath: string) =>
      projectHistoryRepository
        .updateFileReference({
          threadId,
          fileReference: filePath,
          updatedAt: IsoDateTime.make(new Date().toISOString()),
        })
        .pipe(Effect.mapError(toPersistenceError("ThreadRecoveryService.cacheFileReference")));

    /**
     * pickNewestOwnedCandidate - Scan the cwd-encoded projects dir and
     * return the newest JSONL whose session_key is either owned by this
     * thread or uncatalogued. Candidates owned by other threads are
     * rejected (Phase 2 ownership filter).
     *
     * Used by Phase 3's staleness check: if step 1 resumed via a stored
     * session_key but the cwd now holds a strictly-newer same-thread
     * JSONL (e.g., post-/compact), prefer the newer one.
     */
    const pickNewestOwnedCandidate = (input: RecoverInput, claudeHome: string) =>
      Effect.gen(function* () {
        const dir = Path.join(claudeHome, "projects", encodeCwdForClaudeProjects(input.cwd));
        const candidates = yield* Effect.promise(() => readJsonlCandidates(dir));
        if (candidates.length === 0) {
          return Option.none<{
            readonly sessionId: string;
            readonly filePath: string;
            readonly mtimeMs: number;
          }>();
        }
        const sorted = candidates.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
        for (const candidate of sorted) {
          const owner = yield* projectHistorySessionsRepository
            .getThreadByKey({ sessionKey: candidate.sessionId })
            .pipe(
              Effect.mapError(toPersistenceError("ThreadRecoveryService.staleness.getThreadByKey")),
            );
          if (Option.isSome(owner) && owner.value !== input.threadId) {
            continue;
          }
          return Option.some({
            sessionId: candidate.sessionId,
            filePath: candidate.filePath,
            mtimeMs: candidate.mtimeMs,
          });
        }
        return Option.none<{
          readonly sessionId: string;
          readonly filePath: string;
          readonly mtimeMs: number;
        }>();
      });

    const runSessionKeyStep = (input: RecoverInput, claudeHome: string) =>
      Effect.gen(function* () {
        yield* emitStepStarted(input.threadId, "session-key");
        const row = yield* projectHistoryRepository
          .getById({ threadId: input.threadId })
          .pipe(Effect.mapError(toPersistenceError("ThreadRecoveryService.step1.getById")));
        const history = Option.getOrUndefined(row);
        const sessionKey = history?.sessionKey ?? null;
        if (!sessionKey) {
          yield* emitStepSkipped(input.threadId, "session-key", "no session_key stored");
          return Option.none<RecoveryOutcome>();
        }
        const filePath = resolveClaudeSessionFilePath({
          cwd: input.cwd,
          sessionId: sessionKey,
          claudeHome,
        });
        const usable = yield* Effect.promise(() => claudeSessionFileIsUsable(filePath));
        if (!usable) {
          yield* emitStepFailed(
            input.threadId,
            "session-key",
            `session file missing or empty: ${filePath}`,
          );
          return Option.none<RecoveryOutcome>();
        }

        // Phase 3 staleness check (plan #523). The imperative
        // `session_key` sync via `ProviderSessionDirectory.upsert`
        // normally keeps pace with /compact and other session advances
        // (confirmed 2026-04-20 on thread `c96c5304`). If it ever fails
        // to catch an advance, the stored session_key can point at a
        // stale JSONL while a fresher same-thread JSONL already sits in
        // the cwd. To stay robust, peek at the cwd's newest
        // ownership-filtered candidate and prefer it if strictly newer.
        //
        // Threshold: strictly newer mtime (any newer file wins).
        // Equality does NOT qualify. If this proves too aggressive in
        // practice (e.g., tool state churn producing transient newer
        // siblings), tighten to a "> N minutes" window here.
        const storedStat = yield* Effect.promise(() => Fs.stat(filePath).catch(() => null));
        if (storedStat && storedStat.isFile()) {
          const newest = yield* pickNewestOwnedCandidate(input, claudeHome);
          if (Option.isSome(newest)) {
            const candidate = newest.value;
            if (candidate.filePath !== filePath && candidate.mtimeMs > storedStat.mtimeMs) {
              const skewMs = candidate.mtimeMs - storedStat.mtimeMs;
              yield* emitStepSucceeded(
                input.threadId,
                "session-key",
                `thread.recovery.prefer-newer-in-cwd: stored=${sessionKey} (${filePath}) -> newer=${candidate.sessionId} (${candidate.filePath}), skewMs=${skewMs}`,
              );
              const preferOutcome: RecoveryOutcome = {
                _tag: "resumed",
                step: "session-key",
                sessionKey: candidate.sessionId,
                filePath: candidate.filePath,
              };
              return Option.some(preferOutcome);
            }
          }
        }

        yield* emitStepSucceeded(
          input.threadId,
          "session-key",
          `resumed via session_key=${sessionKey}`,
        );
        const outcome: RecoveryOutcome = {
          _tag: "resumed",
          step: "session-key",
          sessionKey,
          filePath,
        };
        return Option.some(outcome);
      });

    const runFileReferenceStep = (input: RecoverInput) =>
      Effect.gen(function* () {
        yield* emitStepStarted(input.threadId, "file-reference");
        const row = yield* projectHistoryRepository
          .getById({ threadId: input.threadId })
          .pipe(Effect.mapError(toPersistenceError("ThreadRecoveryService.step2.getById")));
        const history = Option.getOrUndefined(row);
        const fileReference = history?.fileReference ?? null;
        if (!fileReference) {
          yield* emitStepSkipped(input.threadId, "file-reference", "no file_reference stored");
          return Option.none<RecoveryOutcome>();
        }
        const usable = yield* Effect.promise(() => claudeSessionFileIsUsable(fileReference));
        if (!usable) {
          yield* emitStepFailed(
            input.threadId,
            "file-reference",
            `file_reference missing or empty: ${fileReference}`,
          );
          return Option.none<RecoveryOutcome>();
        }
        const base = Path.basename(fileReference);
        const sessionKey = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
        yield* emitStepSucceeded(
          input.threadId,
          "file-reference",
          `resumed via file_reference=${fileReference}`,
        );
        const outcome: RecoveryOutcome = {
          _tag: "resumed",
          step: "file-reference",
          sessionKey,
          filePath: fileReference,
        };
        return Option.some(outcome);
      });

    const runScanStep = (
      input: RecoverInput,
      step: "scan-current-cwd" | "scan-all-cwds",
      claudeHome: string,
      now: number,
    ) =>
      Effect.gen(function* () {
        yield* emitStepStarted(input.threadId, step);
        const dirs: ReadonlyArray<string> =
          step === "scan-current-cwd"
            ? [Path.join(claudeHome, "projects", encodeCwdForClaudeProjects(input.cwd))]
            : yield* Effect.promise(() => readProjectDirs(claudeHome));

        if (dirs.length === 0) {
          yield* emitStepSkipped(input.threadId, step, "no project directories found");
          return Option.none<RecoveryOutcome>();
        }

        const all: Array<{
          readonly sessionId: string;
          readonly filePath: string;
          readonly mtimeMs: number;
        }> = [];
        for (const dir of dirs) {
          const candidates = yield* Effect.promise(() => readJsonlCandidates(dir));
          for (const c of candidates) {
            all.push(c);
          }
        }
        if (all.length === 0) {
          yield* emitStepSkipped(input.threadId, step, "no JSONL files found");
          return Option.none<RecoveryOutcome>();
        }
        const fresh = all.filter((c) => now - c.mtimeMs <= freshnessWindowMs);
        if (fresh.length === 0) {
          yield* emitStepSkipped(
            input.threadId,
            step,
            `no JSONL files within freshness window of ${freshnessWindowMs}ms`,
          );
          return Option.none<RecoveryOutcome>();
        }
        fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);

        // Ownership filter. See migration 029 + plan #523 Phase 2.
        // The cwd-encoded directory can contain JSONLs belonging to
        // other threads that happened to share the cwd (observed with
        // #copy-writing + #HMR under /mnt/dev/www/tachepharmacy). Before
        // accepting a candidate, look its session_key up in
        // project_history_sessions:
        //   - returns another thread's id → reject silently.
        //   - returns this thread's id    → accept.
        //   - returns null                → accept as uncatalogued (the
        //                                   step succeeds and we record
        //                                   it below so future scans
        //                                   can short-circuit).
        //
        // TODO(plan #523 Phase 2 notes): JSONL preservation — the
        // current implementation does not touch `utimes` on the winning
        // file, so a subsequent `claude --resume` that rewrites the
        // file can still age newer siblings past the freshness window.
        // Snapshot-on-archive is the proposed fix and is deferred out
        // of this PR.
        let winner:
          | {
              readonly sessionId: string;
              readonly filePath: string;
              readonly mtimeMs: number;
              readonly ownerKnown: boolean;
            }
          | undefined;
        for (const candidate of fresh) {
          const owner = yield* projectHistorySessionsRepository
            .getThreadByKey({ sessionKey: candidate.sessionId })
            .pipe(Effect.mapError(toPersistenceError("ThreadRecoveryService.scan.getThreadByKey")));
          if (Option.isSome(owner) && owner.value !== input.threadId) {
            // Owned by another thread — skip.
            continue;
          }
          winner = {
            sessionId: candidate.sessionId,
            filePath: candidate.filePath,
            mtimeMs: candidate.mtimeMs,
            ownerKnown: Option.isSome(owner),
          };
          break;
        }

        if (!winner) {
          yield* emitStepSkipped(
            input.threadId,
            step,
            "all JSONL candidates are owned by other threads",
          );
          return Option.none<RecoveryOutcome>();
        }

        yield* cachedFileReference(input.threadId, winner.filePath);

        // Catalog this session_key for our thread so future scans
        // short-circuit the ownership check on the fast path. Only
        // needed when the candidate was uncatalogued (ownerKnown ===
        // false) — if it was already owned by us, the row is current.
        if (!winner.ownerKnown) {
          yield* projectHistorySessionsRepository
            .recordSession({
              threadId: input.threadId,
              sessionKey: winner.sessionId,
              firstSeenAt: IsoDateTime.make(new Date(now).toISOString()),
            })
            .pipe(Effect.mapError(toPersistenceError("ThreadRecoveryService.scan.recordSession")));
        }

        yield* emitStepSucceeded(input.threadId, step, `resumed via scan: ${winner.filePath}`);
        const outcome: RecoveryOutcome = {
          _tag: "resumed",
          step,
          sessionKey: winner.sessionId,
          filePath: winner.filePath,
        };
        return Option.some(outcome);
      });

    const runDbReplayStep = (input: RecoverInput) =>
      Effect.gen(function* () {
        yield* emitStepStarted(input.threadId, "db-replay");
        const messages = yield* threadMessageRepository
          .listByThreadId({ threadId: input.threadId })
          .pipe(
            Effect.mapError((cause) =>
              toPersistenceError("ThreadRecoveryService.step5.listByThreadId")(cause),
            ),
          );
        const transcript = renderTranscript(
          messages.map((m) => ({ role: m.role, text: m.text })),
          maxTranscriptChars,
        );
        yield* emitStepSucceeded(
          input.threadId,
          "db-replay",
          `replayed ${messages.length} messages (${transcript.length} chars)`,
        );
        const outcome: RecoveryOutcome = {
          _tag: "replay-with-transcript",
          step: "db-replay",
          transcript,
          messageCount: messages.length,
        };
        return Option.some(outcome);
      });

    const recoverBody = (input: RecoverInput) =>
      Effect.gen(function* () {
        const claudeHome = resolveClaudeHome(defaultClaudeHome);
        const now = Date.now();
        yield* emitStarted(input.threadId, input.cwd);

        // Force-mode shortcut: skip the on-disk rungs and jump straight
        // to db-replay. Used by `/rehydrate-thread` when the user knows
        // the JSONL chain is broken and wants a transcript rebuild
        // unconditionally. We still emit `step-skipped` for each
        // bypassed rung so the progress UI shows the full waterfall.
        if (input.force === "db-replay") {
          for (const skipped of STEP_ORDER) {
            if (skipped === "db-replay") break;
            yield* emitStepSkipped(input.threadId, skipped, "forced db-replay");
          }
          const forcedStep5 = yield* runDbReplayStep(input);
          if (Option.isSome(forcedStep5)) {
            yield* emitCompleted(input.threadId, forcedStep5.value);
            return forcedStep5.value;
          }
          // Shouldn't happen (db-replay always yields an outcome), but
          // mirror the fall-through path from the normal waterfall.
          const forcedFailure: RecoveryOutcome = {
            _tag: "failed",
            attemptedSteps: STEP_ORDER,
            detail: "db-replay returned no outcome (forced)",
          };
          yield* emitCompleted(input.threadId, forcedFailure);
          return yield* new ThreadRecoveryError({
            threadId: input.threadId,
            operation: "ThreadRecoveryService.recover",
            detail: "forced db-replay returned no outcome",
            attemptedSteps: STEP_ORDER,
          });
        }

        const step1 = yield* runSessionKeyStep(input, claudeHome);
        if (Option.isSome(step1)) {
          yield* emitCompleted(input.threadId, step1.value);
          return step1.value;
        }

        const step2 = yield* runFileReferenceStep(input);
        if (Option.isSome(step2)) {
          yield* emitCompleted(input.threadId, step2.value);
          return step2.value;
        }

        const step3 = yield* runScanStep(input, "scan-current-cwd", claudeHome, now);
        if (Option.isSome(step3)) {
          yield* emitCompleted(input.threadId, step3.value);
          return step3.value;
        }

        const step4 = yield* runScanStep(input, "scan-all-cwds", claudeHome, now);
        if (Option.isSome(step4)) {
          yield* emitCompleted(input.threadId, step4.value);
          return step4.value;
        }

        const step5 = yield* runDbReplayStep(input);
        if (Option.isSome(step5)) {
          yield* emitCompleted(input.threadId, step5.value);
          return step5.value;
        }

        // Should be unreachable: step 5 always returns a value (even
        // for threads with zero messages — transcript is "").
        const failure: RecoveryOutcome = {
          _tag: "failed",
          attemptedSteps: STEP_ORDER,
          detail: "db-replay returned no outcome",
        };
        yield* emitCompleted(input.threadId, failure);
        return yield* new ThreadRecoveryError({
          threadId: input.threadId,
          operation: "ThreadRecoveryService.recover",
          detail: "db-replay returned no outcome",
          attemptedSteps: STEP_ORDER,
        });
      });

    /**
     * recover - Wrap `recoverBody` so that any unexpected error path
     * still emits a terminal `completed` event. Without this, a
     * persistence failure at step 1 or step 5 would leave downstream
     * stream observers hanging forever (no "completed" to signal
     * end-of-stream).
     *
     * Uses `matchCauseEffect` instead of `tapError` so that defects and
     * interrupts also trigger the terminal event — `tapError` would
     * only catch typed failures.
     */
    const recover: ThreadRecoveryShape["recover"] = (input) =>
      recoverBody(input).pipe(
        Effect.matchCauseEffect({
          onSuccess: (outcome) => Effect.succeed(outcome),
          onFailure: (cause) =>
            emitCompleted(input.threadId, {
              _tag: "failed",
              attemptedSteps: STEP_ORDER,
              detail: Cause.pretty(cause),
            }).pipe(Effect.andThen(Effect.failCause(cause))),
        }),
      );

    /**
     * recoverStream - Subscribe-then-invoke so the caller's stream sees
     * the `started` event. Using `PubSub.subscribe` directly (vs
     * `Stream.fromPubSub`) makes the subscription synchronous with
     * respect to the subsequent fork, eliminating the
     * subscribe-after-publish race.
     *
     * Errors from `recover` are captured as a `completed: failed` event
     * inside `recover` itself, so the forked fiber can safely ignore
     * its own error channel — the stream will always see a `completed`
     * event before the subscription queue runs dry.
     */
    const recoverStream: ThreadRecoveryShape["recoverStream"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          yield* Effect.forkScoped(recover(input).pipe(Effect.ignoreCause({ log: true })));
          return Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.threadId === input.threadId),
            Stream.takeUntil((event) => event._tag === "completed"),
          );
        }),
      );

    /**
     * debugBreak - Clear session_key + file_reference in one atomic
     * pair of updates. The order matters only loosely (both target the
     * same row via updated_at) but we do file_reference last so an
     * observer that races the updates never sees "file_reference
     * present but session_key cleared" which could confuse step 2 of
     * the waterfall into thinking the cache is fresh.
     *
     * No-op if the row doesn't exist yet — intentional, matches the
     * repo-level no-op semantics.
     */
    const debugBreak: ThreadRecoveryShape["debugBreak"] = (input) =>
      Effect.gen(function* () {
        const now = IsoDateTime.make(new Date().toISOString());
        yield* projectHistoryRepository
          .updateSessionKey({ threadId: input.threadId, sessionKey: null, updatedAt: now })
          .pipe(Effect.mapError(toPersistenceError("ThreadRecoveryService.debugBreak.sessionKey")));
        yield* projectHistoryRepository
          .updateFileReference({ threadId: input.threadId, fileReference: null, updatedAt: now })
          .pipe(
            Effect.mapError(toPersistenceError("ThreadRecoveryService.debugBreak.fileReference")),
          );
      });

    /**
     * scheduleRehydrate - Flag a thread for forced db-replay on its
     * next session spawn. See `ThreadRecoveryShape` docstring for the
     * lifecycle rules (in-memory, one-shot, restart-loses).
     */
    const scheduleRehydrate: ThreadRecoveryShape["scheduleRehydrate"] = (threadId) =>
      Effect.sync(() => {
        pendingRehydrate.add(threadId);
      });

    /**
     * consumePendingRehydrate - Read-and-clear the flag set by
     * `scheduleRehydrate`. Delete-on-read ensures that if two spawns
     * race (shouldn't happen in practice) only the first one sees the
     * marker.
     */
    const consumePendingRehydrate: ThreadRecoveryShape["consumePendingRehydrate"] = (threadId) =>
      Effect.sync(() => {
        const pending = pendingRehydrate.has(threadId);
        if (pending) {
          pendingRehydrate.delete(threadId);
        }
        return pending;
      });

    return {
      recover,
      recoverStream,
      debugBreak,
      scheduleRehydrate,
      consumePendingRehydrate,
      get streamEvents() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies ThreadRecoveryShape;
  });

export const ThreadRecoveryLive = Layer.effect(ThreadRecoveryService, makeThreadRecovery());

export function makeThreadRecoveryLive(options?: ThreadRecoveryLiveOptions) {
  return Layer.effect(ThreadRecoveryService, makeThreadRecovery(options));
}
