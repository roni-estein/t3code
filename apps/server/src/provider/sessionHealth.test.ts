import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "vitest";

import {
  claudeSessionFileExists,
  encodeCwdForClaudeProjects,
  resolveClaudeSessionFilePath,
} from "./sessionHealth.ts";

describe("encodeCwdForClaudeProjects", () => {
  it("replaces slashes with dashes", () => {
    assert.equal(
      encodeCwdForClaudeProjects("/mnt/dev/www/tachepharmacy"),
      "-mnt-dev-www-tachepharmacy",
    );
    assert.equal(encodeCwdForClaudeProjects("/Users/roni"), "-Users-roni");
    assert.equal(encodeCwdForClaudeProjects("/"), "-");
  });
});

describe("resolveClaudeSessionFilePath", () => {
  it("constructs the expected jsonl path", () => {
    assert.equal(
      resolveClaudeSessionFilePath({
        cwd: "/mnt/dev/www/tachepharmacy",
        sessionId: "abc-123",
        claudeHome: "/home/roni/.claude",
      }),
      "/home/roni/.claude/projects/-mnt-dev-www-tachepharmacy/abc-123.jsonl",
    );
  });
});

describe("claudeSessionFileExists", () => {
  let tmp: string;
  const cwd = "/some/project";
  const sessionId = "deadbeef-1234";

  beforeEach(async () => {
    tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "t3-session-health-"));
  });

  afterEach(async () => {
    await Fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns true when the jsonl exists and is non-empty", async () => {
    const dir = Path.join(tmp, "projects", "-some-project");
    await Fs.mkdir(dir, { recursive: true });
    await Fs.writeFile(Path.join(dir, `${sessionId}.jsonl`), '{"fake":"event"}\n');

    const exists = await claudeSessionFileExists({ cwd, sessionId, claudeHome: tmp });
    assert.equal(exists, true);
  });

  it("returns false when the jsonl is missing", async () => {
    const exists = await claudeSessionFileExists({ cwd, sessionId, claudeHome: tmp });
    assert.equal(exists, false);
  });

  it("returns false when the jsonl is empty (truncated mid-write)", async () => {
    const dir = Path.join(tmp, "projects", "-some-project");
    await Fs.mkdir(dir, { recursive: true });
    await Fs.writeFile(Path.join(dir, `${sessionId}.jsonl`), "");

    const exists = await claudeSessionFileExists({ cwd, sessionId, claudeHome: tmp });
    assert.equal(exists, false);
  });

  it("returns false when the path is a directory, not a file", async () => {
    const dir = Path.join(tmp, "projects", "-some-project", `${sessionId}.jsonl`);
    await Fs.mkdir(dir, { recursive: true });

    const exists = await claudeSessionFileExists({ cwd, sessionId, claudeHome: tmp });
    assert.equal(exists, false);
  });
});
