import { Data } from "effect";

export class AcpSpawnError extends Data.TaggedError("AcpSpawnError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AcpParseError extends Data.TaggedError("AcpParseError")<{
  readonly line: string;
  readonly cause?: unknown;
}> {}

export class AcpRpcError extends Data.TaggedError("AcpRpcError")<{
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

export class AcpProcessExitedError extends Data.TaggedError("AcpProcessExitedError")<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {}

export type AcpError = AcpSpawnError | AcpParseError | AcpRpcError | AcpProcessExitedError;
