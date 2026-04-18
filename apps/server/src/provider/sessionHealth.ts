import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

/**
 * Claude Code stores its per-session jsonl at
 * `$CLAUDE_HOME/.claude/projects/<cwd-encoded>/<sessionId>.jsonl` where
 * `cwd-encoded` is the working-directory path with every `/` replaced by
 * `-`. Observed paths confirm the encoding on both laptop and proximus:
 *   cwd=/mnt/dev/www/tachepharmacy → dir `-mnt-dev-www-tachepharmacy`
 *   cwd=/Users/roni                → dir `-Users-roni`
 *
 * This module's job is to answer: "does Claude actually have a session file
 * for this (cwd, sessionId)?" — so t3 can avoid calling `claude --resume X`
 * when the file has been GC'd / crashed-away / moved. Resuming a missing
 * session surfaces as `No conversation found with session ID: X` which
 * breaks the user's thread with no path forward.
 */

export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export interface ClaudeSessionLookupInput {
  readonly cwd: string;
  readonly sessionId: string;
  /**
   * Optional override for the Claude config directory. Defaults to
   * `<homedir>/.claude`. Useful for tests and for machines that have
   * `CLAUDE_CONFIG_DIR` set.
   */
  readonly claudeHome?: string;
}

export function resolveClaudeSessionFilePath({
  cwd,
  sessionId,
  claudeHome,
}: ClaudeSessionLookupInput): string {
  const home = claudeHome ?? Path.join(Os.homedir(), ".claude");
  const encoded = encodeCwdForClaudeProjects(cwd);
  return Path.join(home, "projects", encoded, `${sessionId}.jsonl`);
}

export async function claudeSessionFileExists(input: ClaudeSessionLookupInput): Promise<boolean> {
  const filePath = resolveClaudeSessionFilePath(input);
  try {
    const stat = await Fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
