import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ClaudeSessionBlobRepositoryError } from "../Errors.ts";

/**
 * ClaudeSessionBlob — a raw snapshot of a Claude Code per-session jsonl
 * file. Used as disaster-recovery insurance against the file disappearing
 * from `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`. See plan
 * #508 and phase 2d of plan #514.
 *
 * The blob is the exact bytes of the jsonl. Byte-for-byte restore rebuilds
 * Claude's view of the conversation; from the CLI's perspective the
 * session was never lost.
 */

export const ClaudeSessionBlobRecord = Schema.Struct({
  id: Schema.Int,
  threadId: Schema.String,
  providerSessionId: Schema.String,
  cwd: Schema.String,
  byteLength: Schema.Int,
  blob: Schema.Uint8Array,
  capturedAt: Schema.DateTimeUtcFromString,
});
export type ClaudeSessionBlobRecord = typeof ClaudeSessionBlobRecord.Type;

export const CaptureClaudeSessionBlobInput = Schema.Struct({
  threadId: Schema.String,
  providerSessionId: Schema.String,
  cwd: Schema.String,
  blob: Schema.Uint8Array,
  capturedAt: Schema.DateTimeUtcFromString,
});
export type CaptureClaudeSessionBlobInput = typeof CaptureClaudeSessionBlobInput.Type;

export const GetLatestClaudeSessionBlobInput = Schema.Struct({
  threadId: Schema.String,
  providerSessionId: Schema.String,
});
export type GetLatestClaudeSessionBlobInput = typeof GetLatestClaudeSessionBlobInput.Type;

export const ListClaudeSessionBlobsInput = Schema.Struct({
  threadId: Schema.String,
});
export type ListClaudeSessionBlobsInput = typeof ListClaudeSessionBlobsInput.Type;

export const PruneClaudeSessionBlobsInput = Schema.Struct({
  threadId: Schema.String,
  providerSessionId: Schema.String,
  /** Keep only the latest N captures; older ones are deleted. */
  keep: Schema.Int,
});
export type PruneClaudeSessionBlobsInput = typeof PruneClaudeSessionBlobsInput.Type;

export interface ClaudeSessionBlobRepositoryShape {
  readonly capture: (
    input: CaptureClaudeSessionBlobInput,
  ) => Effect.Effect<void, ClaudeSessionBlobRepositoryError>;
  readonly getLatest: (
    input: GetLatestClaudeSessionBlobInput,
  ) => Effect.Effect<Option.Option<ClaudeSessionBlobRecord>, ClaudeSessionBlobRepositoryError>;
  readonly list: (
    input: ListClaudeSessionBlobsInput,
  ) => Effect.Effect<ReadonlyArray<ClaudeSessionBlobRecord>, ClaudeSessionBlobRepositoryError>;
  readonly prune: (
    input: PruneClaudeSessionBlobsInput,
  ) => Effect.Effect<number, ClaudeSessionBlobRepositoryError>;
}

export class ClaudeSessionBlobRepository extends Context.Service<
  ClaudeSessionBlobRepository,
  ClaudeSessionBlobRepositoryShape
>()("t3/persistence/Services/ClaudeSessionBlobs/ClaudeSessionBlobRepository") {}
