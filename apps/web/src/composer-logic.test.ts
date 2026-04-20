import { describe, expect, it } from "vitest";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  deriveImageFilenameFromUrl,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  extractDraggedImageUrls,
  isCollapsedCursorAdjacentToInlineToken,
  isComposerAttachmentDrag,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "./composer-logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects slash model query after /model", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps slash command detection active for provider commands", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects $skill trigger at cursor", () => {
    const text = "Use $gh-fi";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "skill",
      query: "gh-fi",
      rangeStart: "Use ".length,
      rangeEnd: text.length,
    });
  });

  it("detects @path trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });

  it("detects @path trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "path",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("path");
    expect(trigger?.query).toBe("");
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("allows path trigger detection to close after selecting a mention", () => {
    const text = "what's in my @AGENTS.md ";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursor = expandCollapsedComposerCursor(text, collapsedCursorAfterMention);

    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });

  it("maps collapsed skill cursor to expanded text cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterSkill)).toBe(
      expandedCursorAfterSkill,
    );
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps expanded mention cursor back to collapsed cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("keeps replacement cursors aligned when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then ".length + 2);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it("maps expanded skill cursor back to collapsed cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterSkill)).toBe(
      collapsedCursorAfterSkill,
    );
  });
});

describe("clampCollapsedComposerCursor", () => {
  it("clamps to collapsed prompt length when mentions are present", () => {
    const text = "open @AGENTS.md then ";

    expect(clampCollapsedComposerCursor(text, text.length)).toBe(
      "open ".length + 1 + " then ".length,
    );
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(
      "open ".length + 1 + " then ".length,
    );
  });
});

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
  });
});

describe("isCollapsedCursorAdjacentToInlineToken", () => {
  it("returns false when no mention exists", () => {
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "right")).toBe(false);
  });

  it("keeps @query typing non-adjacent while no mention pill exists", () => {
    const text = "hello @pac";
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "right")).toBe(false);
  });

  it("detects left adjacency only when cursor is directly after a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd + 1, "left")).toBe(false);
  });

  it("detects right adjacency only when cursor is directly before a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "right")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart - 1, "right")).toBe(false);
  });

  it("treats terminal pills as inline tokens for adjacency checks", () => {
    const text = `open ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} next`;
    const tokenStart = "open ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });

  it("treats skill pills as inline tokens for adjacency checks", () => {
    const text = "run $review-follow-up next";
    const tokenStart = "run ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });
});

describe("isComposerAttachmentDrag", () => {
  it("accepts real File drags (Finder, other apps)", () => {
    expect(isComposerAttachmentDrag(["Files"])).toBe(true);
  });

  it("accepts browser image/link drags that carry text/uri-list", () => {
    expect(isComposerAttachmentDrag(["text/uri-list", "text/html", "text/plain"])).toBe(true);
  });

  it("ignores plain-text drags so Lexical keeps handling them", () => {
    expect(isComposerAttachmentDrag(["text/plain"])).toBe(false);
    expect(isComposerAttachmentDrag(["text/plain", "text/html"])).toBe(false);
  });

  it("ignores an empty type list", () => {
    expect(isComposerAttachmentDrag([])).toBe(false);
  });
});

const makeDraggedData = (entries: Record<string, string>) => ({
  types: Object.keys(entries),
  getData: (type: string) => entries[type] ?? "",
});

describe("extractDraggedImageUrls", () => {
  it("parses a single URL from text/uri-list", () => {
    const data = makeDraggedData({
      "text/uri-list": "https://files.oaiusercontent.com/example.png",
    });
    expect(extractDraggedImageUrls(data)).toEqual(["https://files.oaiusercontent.com/example.png"]);
  });

  it("ignores comment lines in text/uri-list per RFC 2483", () => {
    const data = makeDraggedData({
      "text/uri-list": "# dragged from ChatGPT\nhttps://cdn.example.com/a.png",
    });
    expect(extractDraggedImageUrls(data)).toEqual(["https://cdn.example.com/a.png"]);
  });

  it("falls back to <img src> in text/html when uri-list is missing", () => {
    const data = makeDraggedData({
      "text/html": '<meta charset="utf-8"><img src="https://cdn.example.com/b.webp" alt="dragged">',
    });
    expect(extractDraggedImageUrls(data)).toEqual(["https://cdn.example.com/b.webp"]);
  });

  it("accepts single-quoted src attributes", () => {
    const data = makeDraggedData({
      "text/html": "<img src='https://cdn.example.com/c.gif'>",
    });
    expect(extractDraggedImageUrls(data)).toEqual(["https://cdn.example.com/c.gif"]);
  });

  it("deduplicates the same URL appearing in both uri-list and html", () => {
    const data = makeDraggedData({
      "text/uri-list": "https://cdn.example.com/d.png",
      "text/html": '<img src="https://cdn.example.com/d.png">',
    });
    expect(extractDraggedImageUrls(data)).toEqual(["https://cdn.example.com/d.png"]);
  });

  it("accepts data:image/ and blob: URLs", () => {
    const data = makeDraggedData({
      "text/uri-list": "data:image/png;base64,AAAA",
      "text/html": '<img src="blob:https://example.com/abc-123">',
    });
    expect(extractDraggedImageUrls(data)).toEqual([
      "data:image/png;base64,AAAA",
      "blob:https://example.com/abc-123",
    ]);
  });

  it("rejects non-http schemes and non-image data URLs", () => {
    const data = makeDraggedData({
      "text/uri-list": "file:///Users/alice/secret.txt\nabout:blank\ndata:text/plain,hello",
    });
    expect(extractDraggedImageUrls(data)).toEqual([]);
  });

  it("uses text/plain as a last-resort fallback", () => {
    const data = makeDraggedData({ "text/plain": "https://cdn.example.com/e.png" });
    expect(extractDraggedImageUrls(data)).toEqual(["https://cdn.example.com/e.png"]);
  });

  it("does not fall back to text/plain when uri-list/html already yielded URLs", () => {
    // Guards against an optional-fallthrough bug: the fallback branch must
    // only fire when uri-list AND html produced nothing.
    const data = makeDraggedData({
      "text/uri-list": "https://cdn.example.com/f.png",
      "text/plain": "totally unrelated text that happens to mention https://example.com",
    });
    expect(extractDraggedImageUrls(data)).toEqual(["https://cdn.example.com/f.png"]);
  });

  it("returns an empty array when nothing is extractable", () => {
    expect(extractDraggedImageUrls(makeDraggedData({ "text/plain": "just some text" }))).toEqual(
      [],
    );
    expect(extractDraggedImageUrls(makeDraggedData({}))).toEqual([]);
  });
});

describe("deriveImageFilenameFromUrl", () => {
  it("preserves the original filename when the URL has one", () => {
    expect(deriveImageFilenameFromUrl("https://cdn.example.com/path/photo.png", "image/png")).toBe(
      "photo.png",
    );
  });

  it("strips the query string before extracting the filename", () => {
    expect(
      deriveImageFilenameFromUrl(
        "https://cdn.example.com/path/photo.jpg?token=abc&v=2",
        "image/jpeg",
      ),
    ).toBe("photo.jpg");
  });

  it("adds an extension when the URL path has none", () => {
    expect(deriveImageFilenameFromUrl("https://cdn.example.com/resource/12345", "image/webp")).toBe(
      "12345.webp",
    );
  });

  it("falls back to a generic name when the URL has no usable path", () => {
    expect(deriveImageFilenameFromUrl("https://cdn.example.com/", "image/png")).toBe(
      "dropped-image.png",
    );
  });

  it("falls back to png when the MIME subtype is missing", () => {
    expect(deriveImageFilenameFromUrl("https://cdn.example.com/", "")).toBe("dropped-image.png");
  });

  it("decodes percent-encoded names", () => {
    expect(
      deriveImageFilenameFromUrl("https://cdn.example.com/path/my%20photo.png", "image/png"),
    ).toBe("my photo.png");
  });

  it("handles invalid URLs without throwing", () => {
    expect(deriveImageFilenameFromUrl("not a url", "image/png")).toBe("dropped-image.png");
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /plan command", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
  });

  it("parses standalone /default command", () => {
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
  });

  it("parses standalone /recover-thread command", () => {
    expect(parseStandaloneComposerSlashCommand("/recover-thread")).toBe("recover-thread");
  });

  it("parses standalone /recover-thread with surrounding whitespace", () => {
    expect(parseStandaloneComposerSlashCommand("  /recover-thread  ")).toBe("recover-thread");
  });

  it("parses standalone /debug-break-thread command", () => {
    expect(parseStandaloneComposerSlashCommand("/debug-break-thread")).toBe("debug-break-thread");
  });

  it("is case-insensitive", () => {
    expect(parseStandaloneComposerSlashCommand("/RECOVER-THREAD")).toBe("recover-thread");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/recover-thread now")).toBeNull();
  });

  it("ignores unknown slash commands", () => {
    expect(parseStandaloneComposerSlashCommand("/unknown")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/model")).toBeNull();
  });
});
