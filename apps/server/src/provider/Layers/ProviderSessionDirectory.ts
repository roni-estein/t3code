import { IsoDateTime, type ProviderKind, type ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { ProjectionProjectHistoryRepository } from "../../persistence/Services/ProjectionProjectHistory.ts";
import { ProjectionProjectHistorySessionsRepository } from "../../persistence/Services/ProjectionProjectHistorySessions.ts";
import type { ProviderSessionRuntime } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderKind, ProviderSessionDirectoryPersistenceError> {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return Effect.succeed(providerName);
  }
  return Effect.fail(
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Unknown persisted provider '${providerName}'.`,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

/**
 * Extract the Claude CLI session key from a persisted `resumeCursor`.
 *
 * The Claude adapter shapes the resume cursor as
 * `{ threadId?, resume?, resumeSessionAt?, turnCount? }` and `resume` is
 * the value you'd pass to `claude --resume <key>`. Codex threads store
 * a different shape (`{ threadId }` or `{ opaque }`) with no `resume`
 * field — in that case this returns null, which causes the
 * project_history.session_key to be cleared (correct: if the thread
 * has switched off Claude, the stale Claude session key is no longer
 * the authoritative value).
 */
function readResumeKey(resumeCursor: unknown | null): string | null {
  if (!isRecord(resumeCursor)) {
    return null;
  }
  const resume = resumeCursor.resume;
  return typeof resume === "string" && resume.length > 0 ? resume : null;
}

function toRuntimeBinding(
  runtime: ProviderSessionRuntime,
  operation: string,
): Effect.Effect<ProviderRuntimeBindingWithMetadata, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderKind(runtime.providerName, operation).pipe(
    Effect.map(
      (provider) =>
        ({
          threadId: runtime.threadId,
          provider,
          adapterKey: runtime.adapterKey,
          runtimeMode: runtime.runtimeMode,
          status: runtime.status,
          resumeCursor: runtime.resumeCursor,
          runtimePayload: runtime.runtimePayload,
          lastSeenAt: runtime.lastSeenAt,
        }) satisfies ProviderRuntimeBindingWithMetadata,
    ),
  );
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntimeRepository;
  const projectHistoryRepository = yield* ProjectionProjectHistoryRepository;
  const projectHistorySessionsRepository = yield* ProjectionProjectHistorySessionsRepository;

  const getBinding = (threadId: ThreadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByThreadId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            toRuntimeBinding(value, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map((binding) => Option.some(binding)),
            ),
        }),
      ),
    );

  const upsert: ProviderSessionDirectoryShape["upsert"] = Effect.fn(function* (binding) {
    const existing = yield* repository
      .getByThreadId({ threadId: binding.threadId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByThreadId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = new Date().toISOString();
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    const resolvedResumeCursor =
      binding.resumeCursor !== undefined
        ? binding.resumeCursor
        : (existingRuntime?.resumeCursor ?? null);
    yield* repository
      .upsert({
        threadId: resolvedThreadId,
        providerName: binding.provider,
        adapterKey:
          binding.adapterKey ??
          (providerChanged ? binding.provider : (existingRuntime?.adapterKey ?? binding.provider)),
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
        status: binding.status ?? existingRuntime?.status ?? "running",
        lastSeenAt: now,
        resumeCursor: resolvedResumeCursor,
        runtimePayload: mergeRuntimePayload(
          existingRuntime?.runtimePayload ?? null,
          binding.runtimePayload,
        ),
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));

    // Mirror the Claude CLI session key into the project_history recovery
    // index so the ThreadRecoveryService can look it up without joining
    // against provider_session_runtime. See migration 027 for full
    // rationale. This is an UPDATE-only call — if the thread.created
    // event has not yet been projected, it no-ops; the next imperative
    // upsert (every turn writes one) will populate the row.
    const resolvedSessionKey = readResumeKey(resolvedResumeCursor);
    yield* projectHistoryRepository
      .updateSessionKey({
        threadId: resolvedThreadId,
        sessionKey: resolvedSessionKey,
        updatedAt: IsoDateTime.make(now),
      })
      .pipe(
        Effect.mapError(
          toPersistenceError("ProviderSessionDirectory.upsert:projectHistorySessionKeySync"),
        ),
      );

    // Also append to the session-history sibling table so
    // ThreadRecovery's cwd-scan steps can answer "is this JSONL owned
    // by another thread?" and so the /compact timeline is preserved.
    // See migration 029. `recordSession` is idempotent on
    // (thread, session_key) and atomically supersedes the prior
    // current row when the key advances.
    //
    // Codex-style cursors with no `.resume` field yield a null key
    // above; skip the sibling write in that case (we never store null
    // keys, and clearing a Codex thread should not affect Claude
    // session lineage).
    if (resolvedSessionKey !== null) {
      yield* projectHistorySessionsRepository
        .recordSession({
          threadId: resolvedThreadId,
          sessionKey: resolvedSessionKey,
          firstSeenAt: IsoDateTime.make(now),
        })
        .pipe(
          Effect.mapError(
            toPersistenceError("ProviderSessionDirectory.upsert:projectHistorySessionsSync"),
          ),
        );
    }
  });

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for thread '${threadId}'.`,
              }),
            ),
        }),
      ),
    );

  const listThreadIds: ProviderSessionDirectoryShape["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listThreadIds:list")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listBindings: ProviderSessionDirectoryShape["listBindings"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listBindings:list")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => toRuntimeBinding(row, "ProviderSessionDirectory.listBindings"),
          { concurrency: "unbounded" },
        ),
      ),
    );

  return {
    upsert,
    getProvider,
    getBinding,
    listThreadIds,
    listBindings,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);

export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}
