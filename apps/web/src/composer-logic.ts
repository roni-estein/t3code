import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export type ComposerTriggerKind = "path" | "slash-command" | "slash-model" | "skill";
/**
 * The union of all slash commands the built-in composer menu handles.
 *
 * - `model`              — opens the model picker inline; handled via the
 *                          replacement path (`/model ` → user picks).
 * - `plan` / `default`   — mode toggles; dispatch side-effects via
 *                          `handleInteractionModeChange`.
 * - `recover-thread`     — opens the RecoveryProgressOverlay to drive the
 *                          server-side 5-step recovery waterfall. Accepts
 *                          an optional `<uuid>` arg to operate on a
 *                          different thread than the active one.
 * - `debug-break-thread` — clears `session_key` + `file_reference` on the
 *                          server so the next turn exercises the recovery
 *                          waterfall end-to-end (testing aid).
 * - `diagnose-thread`    — read-only divergence report for a thread.
 *                          Accepts an optional `<uuid>` arg so the user
 *                          can diagnose a broken thread from a healthy
 *                          one.
 * - `reconcile-thread`   — runs Phase-1 reconciliation on demand.
 *                          Accepts an optional `<uuid>` arg.
 * - `rehydrate-thread`   — force the next turn to rebuild Claude's
 *                          context from the thread's projected messages
 *                          (for threads whose JSONL chain is broken and
 *                          automatic recovery can't help). Accepts an
 *                          optional `<uuid>` arg.
 */
export type ComposerSlashCommand =
  | "model"
  | "plan"
  | "default"
  | "recover-thread"
  | "debug-break-thread"
  | "diagnose-thread"
  | "reconcile-thread"
  | "rehydrate-thread";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const isInlineTokenSegment = (
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER
  );
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.path.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return expandedCursor + remaining;
      }
      remaining -= 1;
      expandedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" }
  >,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.path.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return collapsedCursor + remaining;
      }
      remaining -= 1;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export const isCollapsedCursorAdjacentToMention = isCollapsedCursorAdjacentToInlineToken;

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

/**
 * The subset of `ComposerSlashCommand` that can be invoked as a
 * standalone message (type the whole command, press Enter, no
 * arguments beyond optional thread uuids). `model` is excluded because
 * it takes a following argument and is handled via the autocomplete /
 * inline-replacement path instead.
 */
export type StandaloneComposerSlashCommand = Exclude<ComposerSlashCommand, "model">;

/**
 * Parsed representation of a standalone slash command. For the
 * thread-operation commands (`recover-thread`, `diagnose-thread`,
 * `reconcile-thread`) the user may append a uuid: `/diagnose-thread
 * 450c6cc7-…` — the parser strips it into the optional `threadId`
 * field. For mode toggles (`plan` / `default`) and the dev-aid
 * `debug-break-thread` no arg is accepted; any trailing text makes the
 * parser return null.
 */
export interface ParsedStandaloneComposerSlashCommand {
  readonly command: StandaloneComposerSlashCommand;
  readonly threadId: string | null;
}

/**
 * Slash commands that accept an optional uuid argument. Keeping this
 * list tight (rather than accepting any trailing token for every
 * command) stops us from silently eating typos.
 */
const COMMANDS_ACCEPTING_THREAD_ID = new Set<StandaloneComposerSlashCommand>([
  "recover-thread",
  "diagnose-thread",
  "reconcile-thread",
  "rehydrate-thread",
]);

// RFC-4122-ish uuid shape (loose: accepts any 8-4-4-4-12 hex string).
// The server validates strictly via `ThreadId` so this client-side check
// is only a usability guard, not a security boundary.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseStandaloneComposerSlashCommand(
  text: string,
): ParsedStandaloneComposerSlashCommand | null {
  const trimmed = text.trim();
  // Split command name from the remainder of the line. Whitespace
  // between command and arg is required (the command name itself must
  // not contain whitespace). The regex tolerates multiple spaces.
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const name = (match[1] ?? "").toLowerCase();
  const rest = (match[2] ?? "").trim();

  let command: StandaloneComposerSlashCommand;
  switch (name) {
    case "plan":
    case "default":
    case "debug-break-thread":
    case "recover-thread":
    case "diagnose-thread":
    case "reconcile-thread":
    case "rehydrate-thread":
      command = name;
      break;
    default:
      return null;
  }

  if (rest.length === 0) {
    return { command, threadId: null };
  }

  if (!COMMANDS_ACCEPTING_THREAD_ID.has(command)) {
    // Commands that don't take args get rejected if anything trails
    // the name so typos like "/plan now" don't silently fire /plan.
    return null;
  }

  if (!UUID_PATTERN.test(rest)) {
    // The command accepts a uuid but what's there isn't a uuid.
    // Returning null lets the caller surface the input as a normal
    // message (the server can then complain, or the user can notice).
    return null;
  }

  return { command, threadId: rest.toLowerCase() };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

// ---------------------------------------------------------------------------
// Drag-and-drop helpers (images dragged from other browser tabs / apps).
//
// Background: dropping an image straight from another browser tab (e.g. the
// ChatGPT web UI) into the composer does nothing today because the composer's
// drop handler only accepts `DataTransfer.files`. Browser drag sources expose
// the image via `text/uri-list` / `text/html` instead — the destination has
// to fetch the bytes itself.
// ---------------------------------------------------------------------------

/**
 * True when the dragged payload looks attachable — either a real file list
 * (Finder, other apps) or a URL/image reference (another browser tab).
 *
 * Gating on `text/uri-list` (rather than any text/*) keeps plain-text drags
 * from flipping the drop-zone highlight and from being hijacked away from
 * the Lexical editor's native text-drop behavior.
 */
export function isComposerAttachmentDrag(types: ReadonlyArray<string>): boolean {
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Extract candidate image URLs from a DataTransfer-like payload. Used when a
 * drop carried no real `Files` (image dragged from another browser window).
 *
 * Preference order mirrors what browsers actually populate for image drags:
 *   1. `text/uri-list` — the standard; one URL per non-comment line.
 *   2. `text/html`     — parse `<img src>` attributes for cases where the
 *                        source only populated rich HTML.
 *   3. `text/plain`    — last-resort fallback; some sources put the URL here.
 *
 * Only `http(s):`, `data:image/*`, and `blob:` URLs are returned — everything
 * else (chrome://, about:, file:, arbitrary text) is filtered out so the
 * caller can safely `fetch()` the result.
 */
export function extractDraggedImageUrls(data: {
  getData: (type: string) => string;
  types: ReadonlyArray<string>;
}): string[] {
  const urls: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!/^(?:https?:|data:image\/|blob:)/i.test(trimmed)) return;
    if (!urls.includes(trimmed)) urls.push(trimmed);
  };

  if (data.types.includes("text/uri-list")) {
    const raw = data.getData("text/uri-list");
    if (raw) {
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("#")) continue;
        push(line);
      }
    }
  }
  if (data.types.includes("text/html")) {
    const html = data.getData("text/html");
    if (html) {
      // Match <img ... src="..."> or src='...'; tolerate other attrs in between.
      const pattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
      for (const match of html.matchAll(pattern)) {
        push(match[1] ?? match[2]);
      }
    }
  }
  if (urls.length === 0 && data.types.includes("text/plain")) {
    push(data.getData("text/plain"));
  }
  return urls;
}

/**
 * Derive a reasonable filename for a File fetched from a URL.
 *
 * - Strips the query string and takes the last non-empty path segment.
 * - Falls back to `dropped-image.<ext>` when the URL has no usable name.
 * - Infers extension from the MIME type when the derived name has none.
 */
export function deriveImageFilenameFromUrl(url: string, mimeType: string): string {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = "";
  }
  const last = pathname.split("/").findLast((segment) => segment.length > 0) ?? "";
  const cleaned = decodeURIComponent(last)
    .replace(/[\r\n\t]/g, "")
    .trim();
  if (cleaned && /\.[a-z0-9]{1,6}$/i.test(cleaned)) return cleaned;
  const ext = mimeType.split("/")[1]?.split(";")[0]?.trim() || "png";
  if (cleaned) return `${cleaned}.${ext}`;
  return `dropped-image.${ext}`;
}
