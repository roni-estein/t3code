import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  type ModelCapabilities,
} from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  getDefaultEffort,
  getDefaultReasoningEffort,
  getEffectiveClaudeCodeEffort,
  hasEffortLevel,
  inferProviderForModel,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeModelSlug,
  parseCursorModelSelection,
  resolveCursorDispatchModel,
  resolveCursorModelFromSelection,
  resolveModelSlug,
  resolveModelSlugForProvider,
  resolveReasoningEffortForProvider,
  resolveSelectableModel,
  supportsClaudeAdaptiveReasoning,
  supportsClaudeFastMode,
  supportsClaudeMaxEffort,
  supportsClaudeThinkingToggle,
  supportsClaudeUltrathinkKeyword,
  trimOrNull,
} from "./model";

const codexCaps: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "xhigh", label: "Extra High" },
    { value: "high", label: "High", isDefault: true },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
};

const claudeCaps: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "ultrathink", label: "Ultrathink" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: ["ultrathink"],
};

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });
});

describe("resolveModelSlug", () => {
  it("returns defaults when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlugForProvider("claudeAgent", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("preserves normalized unknown models", () => {
    expect(resolveModelSlug("custom/internal-model")).toBe("custom/internal-model");
  });
});

describe("resolveSelectableModel", () => {
  it("resolves exact slugs, labels, and aliases", () => {
    const options = [
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];
    expect(resolveSelectableModel("codex", "gpt-5.3-codex", options)).toBe("gpt-5.3-codex");
    expect(resolveSelectableModel("codex", "gpt-5.3 codex", options)).toBe("gpt-5.3-codex");
    expect(resolveSelectableModel("claudeAgent", "sonnet", options)).toBe("claude-sonnet-4-6");
  });
});

describe("capability helpers", () => {
  it("reads default efforts", () => {
    expect(getDefaultEffort(codexCaps)).toBe("high");
    expect(getDefaultEffort(claudeCaps)).toBe("high");
  });

  it("checks effort support", () => {
    expect(hasEffortLevel(codexCaps, "xhigh")).toBe(true);
    expect(hasEffortLevel(codexCaps, "max")).toBe(false);
  });
});

describe("inferProviderForModel", () => {
  it("detects known provider model slugs", () => {
    expect(inferProviderForModel("gpt-5.3-codex")).toBe("codex");
    expect(inferProviderForModel("claude-sonnet-4-6")).toBe("claudeAgent");
    expect(inferProviderForModel("sonnet")).toBe("claudeAgent");
  });

  it("falls back when the model is unknown", () => {
    expect(inferProviderForModel("custom/internal-model")).toBe("codex");
    expect(inferProviderForModel("custom/internal-model", "claudeAgent")).toBe("claudeAgent");
  });

  it("treats claude-prefixed custom slugs as claude", () => {
    expect(inferProviderForModel("claude-custom-internal")).toBe("claudeAgent");
  });

  it("infers cursor from Cursor-only slugs", () => {
    expect(inferProviderForModel("claude-4.6-opus-high-thinking")).toBe("cursor");
    expect(inferProviderForModel("composer-1.5")).toBe("cursor");
  });

  it("infers cursor from family slugs", () => {
    expect(inferProviderForModel("composer-2")).toBe("cursor");
    expect(inferProviderForModel("gpt-5.4-1m")).toBe("cursor");
    expect(inferProviderForModel("claude-4.6-opus")).toBe("cursor");
    expect(inferProviderForModel("claude-4.6-sonnet")).toBe("cursor");
    expect(inferProviderForModel("auto")).toBe("cursor");
  });
});

describe("cursor model selection helpers", () => {
  it("parses GPT-5.3 Codex reasoning and fast suffixes from slugs", () => {
    expect(parseCursorModelSelection("gpt-5.3-codex-high-fast")).toMatchObject({
      family: "gpt-5.3-codex",
      reasoning: "high",
      fast: true,
      thinking: false,
    });
  });

  it("merges persisted cursor modelOptions over the family model key", () => {
    expect(parseCursorModelSelection("composer-2", { fastMode: true })).toMatchObject({
      family: "composer-2",
      fast: true,
    });
    expect(resolveCursorDispatchModel("composer-2", { fastMode: true })).toBe("composer-2-fast");
    expect(resolveCursorDispatchModel("composer-2", undefined)).toBe("composer-2");
  });

  it("parses and resolves Claude Opus 4.6 tiers and thinking from CLI slugs", () => {
    expect(parseCursorModelSelection("claude-4.6-opus-high-thinking")).toMatchObject({
      family: "claude-4.6-opus",
      thinking: true,
      claudeOpusTier: "high",
    });
    expect(parseCursorModelSelection("claude-4.6-opus-max")).toMatchObject({
      claudeOpusTier: "max",
      thinking: false,
    });
    expect(
      resolveCursorModelFromSelection({
        family: "claude-4.6-opus",
        thinking: true,
        claudeOpusTier: "high",
      }),
    ).toBe("claude-4.6-opus-high-thinking");
    expect(
      resolveCursorModelFromSelection({
        family: "claude-4.6-opus",
        thinking: false,
        claudeOpusTier: "max",
      }),
    ).toBe("claude-4.6-opus-max");
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe(DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex);
    expect(getDefaultReasoningEffort("claudeAgent")).toBe(
      DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent,
    );
    expect(getDefaultReasoningEffort("cursor")).toBe(DEFAULT_REASONING_EFFORT_BY_PROVIDER.cursor);
  });
});

describe("resolveReasoningEffortForProvider", () => {
  it("accepts provider-scoped effort values", () => {
    expect(resolveReasoningEffortForProvider("codex", "xhigh")).toBe("xhigh");
    expect(resolveReasoningEffortForProvider("claudeAgent", "ultrathink")).toBe("ultrathink");
  });

  it("rejects effort values from the wrong provider", () => {
    expect(resolveReasoningEffortForProvider("codex", "max")).toBeNull();
    expect(resolveReasoningEffortForProvider("claudeAgent", "xhigh")).toBeNull();
  });

  it("accepts cursor reasoning tiers", () => {
    expect(resolveReasoningEffortForProvider("cursor", "normal")).toBe("normal");
    expect(resolveReasoningEffortForProvider("cursor", "xhigh")).toBe("xhigh");
  });
});

describe("getEffectiveClaudeCodeEffort", () => {
  it("does not persist ultrathink into Claude runtime configuration", () => {
    expect(getEffectiveClaudeCodeEffort("ultrathink")).toBeNull();
    expect(getEffectiveClaudeCodeEffort("high")).toBe("high");
  });

  it("returns null when no claude effort is selected", () => {
    expect(getEffectiveClaudeCodeEffort(null)).toBeNull();
    expect(getEffectiveClaudeCodeEffort(undefined)).toBeNull();
  });
});

describe("normalizeCodexModelOptions", () => {
  it("drops default-only codex options", () => {
    expect(
      normalizeCodexModelOptions({ reasoningEffort: "high", fastMode: false }),
    ).toBeUndefined();
  });

  it("preserves non-default codex options", () => {
    expect(normalizeCodexModelOptions({ reasoningEffort: "xhigh", fastMode: true })).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    });
  });
});

describe("normalizeClaudeModelOptions", () => {
  it("drops unsupported fast mode and max effort for Sonnet", () => {
    expect(
      normalizeClaudeModelOptions("claude-sonnet-4-6", {
        effort: "max",
        fastMode: true,
      }),
    ).toBeUndefined();
  });

  it("keeps the Haiku thinking toggle and removes unsupported effort", () => {
    expect(
      normalizeClaudeModelOptions("claude-haiku-4-5", {
        thinking: false,
        effort: "high",
      }),
    ).toEqual({
      thinking: false,
    });
  });
});

describe("supportsClaudeAdaptiveReasoning", () => {
  it("only enables adaptive reasoning for Opus 4.6 and Sonnet 4.6", () => {
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-sonnet-4-6")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-haiku-4-5")).toBe(false);
    expect(supportsClaudeAdaptiveReasoning(undefined)).toBe(false);
  });
});

describe("supportsClaudeMaxEffort", () => {
  it("only enables max effort for Opus 4.6", () => {
    expect(supportsClaudeMaxEffort("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeMaxEffort("claude-sonnet-4-6")).toBe(false);
    expect(supportsClaudeMaxEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsClaudeMaxEffort(undefined)).toBe(false);
  });
});

describe("supportsClaudeFastMode", () => {
  it("only enables Claude fast mode for Opus 4.6", () => {
    expect(supportsClaudeFastMode("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeFastMode("opus")).toBe(true);
    expect(supportsClaudeFastMode("claude-sonnet-4-6")).toBe(false);
    expect(supportsClaudeFastMode("claude-haiku-4-5")).toBe(false);
    expect(supportsClaudeFastMode(undefined)).toBe(false);
  });
});

describe("supportsClaudeUltrathinkKeyword", () => {
  it("only enables ultrathink keyword handling for Opus 4.6 and Sonnet 4.6", () => {
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeUltrathinkKeyword("claude-sonnet-4-6")).toBe(true);
    expect(supportsClaudeUltrathinkKeyword("claude-haiku-4-5")).toBe(false);
  });
});

describe("supportsClaudeThinkingToggle", () => {
  it("only enables the Claude thinking toggle for Haiku 4.5", () => {
    expect(supportsClaudeThinkingToggle("claude-opus-4-6")).toBe(false);
    expect(supportsClaudeThinkingToggle("claude-sonnet-4-6")).toBe(false);
    expect(supportsClaudeThinkingToggle("claude-haiku-4-5")).toBe(true);
    expect(supportsClaudeThinkingToggle("haiku")).toBe(true);
    expect(supportsClaudeThinkingToggle(undefined)).toBe(false);
  });
});

describe("misc helpers", () => {
  it("detects ultrathink prompts", () => {
    expect(isClaudeUltrathinkPrompt("Please ultrathink about this")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Investigate")).toBe(false);
  });

  it("prefixes ultrathink prompts once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
  });

  it("trims strings to null", () => {
    expect(trimOrNull("  hi  ")).toBe("hi");
    expect(trimOrNull("   ")).toBeNull();
  });
});
