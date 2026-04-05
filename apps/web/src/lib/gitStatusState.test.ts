import { GitManagerError, type GitStatusResult } from "@t3tools/contracts";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";

import { deriveGitStatusState, pruneStatusByCwd } from "./gitStatusState";

const BASE_STATUS: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/push-status",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("deriveGitStatusState", () => {
  it("uses the latest streamed snapshot as the current git status", () => {
    const streamedStatuses: [GitStatusResult, ...GitStatusResult[]] = [
      BASE_STATUS,
      { ...BASE_STATUS, branch: "feature/updated-status" },
    ];
    const state = deriveGitStatusState(
      AsyncResult.success({
        done: false,
        items: streamedStatuses,
      }),
    );

    expect(state).toEqual({
      data: { ...BASE_STATUS, branch: "feature/updated-status" },
      error: null,
      cause: null,
      isPending: false,
    });
  });

  it("preserves the previous snapshot when the stream fails after succeeding", () => {
    const previousSuccess = AsyncResult.success({
      done: false,
      items: [BASE_STATUS] as [GitStatusResult],
    });
    const error = new GitManagerError({
      operation: "subscribeGitStatus",
      detail: "stream disconnected",
    });
    const state = deriveGitStatusState(
      AsyncResult.failure(Cause.fail(error), {
        previousSuccess: Option.some(previousSuccess),
      }),
    );

    expect(state.data).toEqual(BASE_STATUS);
    expect(state.error).toBe(error);
    expect(state.isPending).toBe(false);
  });

  it("prunes stale cwd entries when the tracked cwd list shrinks", () => {
    const current = new Map<string, GitStatusResult>([
      ["/repo/a", BASE_STATUS],
      ["/repo/b", { ...BASE_STATUS, branch: "feature/other" }],
    ]);

    expect(pruneStatusByCwd(current, ["/repo/b"])).toEqual(
      new Map([["/repo/b", { ...BASE_STATUS, branch: "feature/other" }]]),
    );
  });
});
