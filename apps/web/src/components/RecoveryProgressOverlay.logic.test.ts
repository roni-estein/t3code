import type { RecoveryProgressEvent, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import {
  applyRecoveryProgressEvent,
  foldRecoveryProgressEvents,
  initialRecoveryOverlayViewModel,
  summarizeRecoveryOutcome,
} from "./RecoveryProgressOverlay.logic";

const THREAD_ID = "thread-under-recovery" as ThreadId;
const CWD = "/tmp/workspace";

describe("initialRecoveryOverlayViewModel", () => {
  it("starts in idle phase with all five steps pending", () => {
    assert.equal(initialRecoveryOverlayViewModel.phase, "idle");
    assert.equal(initialRecoveryOverlayViewModel.outcome, null);
    assert.equal(initialRecoveryOverlayViewModel.steps.length, 5);
    assert.deepEqual(
      initialRecoveryOverlayViewModel.steps.map((entry) => entry.step),
      ["session-key", "file-reference", "scan-current-cwd", "scan-all-cwds", "db-replay"],
    );
    assert.isTrue(
      initialRecoveryOverlayViewModel.steps.every((entry) => entry.status === "pending"),
    );
  });
});

describe("applyRecoveryProgressEvent", () => {
  it("transitions to running phase on 'started' and clears previous per-step state", () => {
    const priorModel = foldRecoveryProgressEvents([
      { _tag: "started", threadId: THREAD_ID, cwd: CWD },
      { _tag: "step-started", threadId: THREAD_ID, step: "session-key" },
      { _tag: "step-failed", threadId: THREAD_ID, step: "session-key", reason: "stale" },
    ] satisfies RecoveryProgressEvent[]);

    assert.equal(priorModel.steps[0]?.status, "failed");

    const next = applyRecoveryProgressEvent(priorModel, {
      _tag: "started",
      threadId: THREAD_ID,
      cwd: CWD,
    });

    assert.equal(next.phase, "running");
    assert.isTrue(next.steps.every((entry) => entry.status === "pending"));
  });

  it("marks step as running with detail cleared on 'step-started'", () => {
    const next = foldRecoveryProgressEvents([
      { _tag: "started", threadId: THREAD_ID, cwd: CWD },
      { _tag: "step-started", threadId: THREAD_ID, step: "file-reference" },
    ] satisfies RecoveryProgressEvent[]);

    const entry = next.steps.find((item) => item.step === "file-reference");
    assert.equal(entry?.status, "running");
    assert.equal(entry?.detail, null);
  });

  it("records detail message on 'step-succeeded'", () => {
    const next = foldRecoveryProgressEvents([
      { _tag: "started", threadId: THREAD_ID, cwd: CWD },
      { _tag: "step-started", threadId: THREAD_ID, step: "scan-current-cwd" },
      {
        _tag: "step-succeeded",
        threadId: THREAD_ID,
        step: "scan-current-cwd",
        detail: "/home/user/.claude/projects/-tmp-workspace/abc123.jsonl",
      },
    ] satisfies RecoveryProgressEvent[]);

    const entry = next.steps.find((item) => item.step === "scan-current-cwd");
    assert.equal(entry?.status, "succeeded");
    assert.equal(entry?.detail, "/home/user/.claude/projects/-tmp-workspace/abc123.jsonl");
  });

  it("records reason on 'step-skipped'", () => {
    const next = foldRecoveryProgressEvents([
      { _tag: "started", threadId: THREAD_ID, cwd: CWD },
      {
        _tag: "step-skipped",
        threadId: THREAD_ID,
        step: "session-key",
        reason: "no stored session_key for this thread",
      },
    ] satisfies RecoveryProgressEvent[]);

    const entry = next.steps.find((item) => item.step === "session-key");
    assert.equal(entry?.status, "skipped");
    assert.equal(entry?.detail, "no stored session_key for this thread");
  });

  it("records reason on 'step-failed'", () => {
    const next = foldRecoveryProgressEvents([
      { _tag: "started", threadId: THREAD_ID, cwd: CWD },
      {
        _tag: "step-failed",
        threadId: THREAD_ID,
        step: "file-reference",
        reason: "ENOENT: file missing on disk",
      },
    ] satisfies RecoveryProgressEvent[]);

    const entry = next.steps.find((item) => item.step === "file-reference");
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.detail, "ENOENT: file missing on disk");
  });

  it("transitions to completed phase and captures outcome on 'completed' resumed path", () => {
    const next = foldRecoveryProgressEvents([
      { _tag: "started", threadId: THREAD_ID, cwd: CWD },
      { _tag: "step-started", threadId: THREAD_ID, step: "session-key" },
      {
        _tag: "step-succeeded",
        threadId: THREAD_ID,
        step: "session-key",
        detail: "ok",
      },
      {
        _tag: "completed",
        threadId: THREAD_ID,
        outcome: {
          _tag: "resumed",
          step: "session-key",
          sessionKey: "sess-abc123",
          filePath: "/claude/projects/-tmp-workspace/sess-abc123.jsonl",
        },
      },
    ] satisfies RecoveryProgressEvent[]);

    assert.equal(next.phase, "completed");
    assert.deepEqual(next.outcome, {
      _tag: "resumed",
      step: "session-key",
      sessionKey: "sess-abc123",
      filePath: "/claude/projects/-tmp-workspace/sess-abc123.jsonl",
    });
  });

  it("captures db-replay outcome as the waterfall floor", () => {
    const next = foldRecoveryProgressEvents([
      { _tag: "started", threadId: THREAD_ID, cwd: CWD },
      ...(["session-key", "file-reference", "scan-current-cwd", "scan-all-cwds"] as const).flatMap(
        (step) =>
          [
            { _tag: "step-started", threadId: THREAD_ID, step },
            { _tag: "step-failed", threadId: THREAD_ID, step, reason: "not found" },
          ] satisfies RecoveryProgressEvent[],
      ),
      { _tag: "step-started", threadId: THREAD_ID, step: "db-replay" },
      {
        _tag: "step-succeeded",
        threadId: THREAD_ID,
        step: "db-replay",
        detail: "synthesised transcript from 12 projected messages",
      },
      {
        _tag: "completed",
        threadId: THREAD_ID,
        outcome: {
          _tag: "replay-with-transcript",
          step: "db-replay",
          transcript: "# Transcript\n...",
          messageCount: 12,
        },
      },
    ] satisfies RecoveryProgressEvent[]);

    assert.equal(next.phase, "completed");
    assert.equal(next.outcome?._tag, "replay-with-transcript");
    if (next.outcome?._tag === "replay-with-transcript") {
      assert.equal(next.outcome.messageCount, 12);
    }
  });
});

describe("summarizeRecoveryOutcome", () => {
  it("names the resumed step", () => {
    const summary = summarizeRecoveryOutcome({
      _tag: "resumed",
      step: "scan-current-cwd",
      sessionKey: "sess-1",
      filePath: "/tmp/file.jsonl",
    });
    assert.include(summary.toLowerCase(), "scan current workspace");
  });

  it("uses singular grammar for one message", () => {
    assert.equal(
      summarizeRecoveryOutcome({
        _tag: "replay-with-transcript",
        step: "db-replay",
        transcript: "",
        messageCount: 1,
      }),
      "Rebuilt 1 message from database history.",
    );
  });

  it("uses plural grammar for multiple messages", () => {
    assert.equal(
      summarizeRecoveryOutcome({
        _tag: "replay-with-transcript",
        step: "db-replay",
        transcript: "",
        messageCount: 5,
      }),
      "Rebuilt 5 messages from database history.",
    );
  });

  it("surfaces failure detail when present", () => {
    const summary = summarizeRecoveryOutcome({
      _tag: "failed",
      attemptedSteps: ["session-key", "file-reference"],
      detail: "disk unreachable",
    });
    assert.include(summary, "disk unreachable");
  });
});
