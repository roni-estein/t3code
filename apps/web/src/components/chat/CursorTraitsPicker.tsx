import {
  CURSOR_CLAUDE_OPUS_TIER_OPTIONS,
  CURSOR_REASONING_OPTIONS,
  type CursorReasoningOption,
  type ThreadId,
} from "@t3tools/contracts";
import type { CursorModelOptions } from "@t3tools/contracts";
import {
  cursorFamilySupportsFastWithReasoning,
  cursorSelectionToPersistedModelOptions,
  getCursorModelCapabilities,
  parseCursorModelSelection,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";

const CURSOR_REASONING_LABELS: Record<CursorReasoningOption, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  xhigh: "Extra high",
};

export const CursorTraitsMenuContent = memo(function CursorTraitsMenuContentImpl({
  threadId,
  model,
  cursorModelOptions,
}: {
  threadId: ThreadId;
  model: string | null | undefined;
  cursorModelOptions: CursorModelOptions | null;
}) {
  const setModelSelection = useComposerDraftStore((s) => s.setModelSelection);
  const setStickyModelSelection = useComposerDraftStore((s) => s.setStickyModelSelection);
  const setProviderModelOptions = useComposerDraftStore((s) => s.setProviderModelOptions);

  const selection = parseCursorModelSelection(model, cursorModelOptions);
  const capability = getCursorModelCapabilities(selection.family);

  const applyNextSelection = useCallback(
    (nextSel: typeof selection) => {
      const persisted = cursorSelectionToPersistedModelOptions(nextSel);
      const nextModelSelection = { provider: "cursor" as const, model: nextSel.family };
      setModelSelection(threadId, nextModelSelection);
      setProviderModelOptions(threadId, "cursor", persisted, { persistSticky: true });
      setStickyModelSelection(nextModelSelection);
    },
    [setModelSelection, setProviderModelOptions, setStickyModelSelection, threadId],
  );

  const showFast =
    capability.supportsFast &&
    cursorFamilySupportsFastWithReasoning(selection.family, selection.reasoning);

  if (
    !capability.supportsReasoning &&
    !showFast &&
    !capability.supportsThinking &&
    !capability.supportsClaudeOpusTier
  ) {
    return null;
  }

  return (
    <>
      {capability.supportsClaudeOpusTier ? (
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            Opus tier
          </div>
          <MenuRadioGroup
            value={selection.claudeOpusTier}
            onValueChange={(value) => {
              const nextTier = CURSOR_CLAUDE_OPUS_TIER_OPTIONS.find((t) => t === value);
              if (!nextTier) return;
              applyNextSelection({
                ...selection,
                claudeOpusTier: nextTier,
              });
            }}
          >
            <MenuRadioItem value="high">High</MenuRadioItem>
            <MenuRadioItem value="max">Max</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {capability.supportsReasoning ? (
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            Reasoning
          </div>
          <MenuRadioGroup
            value={selection.reasoning}
            onValueChange={(value) => {
              const nextReasoning = CURSOR_REASONING_OPTIONS.find((o) => o === value);
              if (!nextReasoning) return;
              applyNextSelection({
                ...selection,
                reasoning: nextReasoning,
              });
            }}
          >
            {CURSOR_REASONING_OPTIONS.map((option) => (
              <MenuRadioItem key={option} value={option}>
                {CURSOR_REASONING_LABELS[option]}
                {option === capability.defaultReasoning ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {showFast ? (
        <>
          {capability.supportsReasoning || capability.supportsClaudeOpusTier ? (
            <MenuDivider />
          ) : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast mode</div>
            <MenuRadioGroup
              value={selection.fast ? "on" : "off"}
              onValueChange={(value) => {
                applyNextSelection({
                  ...selection,
                  fast: value === "on",
                });
              }}
            >
              <MenuRadioItem value="off">Off</MenuRadioItem>
              <MenuRadioItem value="on">On</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {capability.supportsThinking ? (
        <>
          {capability.supportsReasoning || showFast || capability.supportsClaudeOpusTier ? (
            <MenuDivider />
          ) : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
            <MenuRadioGroup
              value={selection.thinking ? "on" : "off"}
              onValueChange={(value) => {
                applyNextSelection({
                  ...selection,
                  thinking: value === "on",
                });
              }}
            >
              <MenuRadioItem value="off">Off</MenuRadioItem>
              <MenuRadioItem value="on">On (default)</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
    </>
  );
});

export const CursorTraitsPicker = memo(function CursorTraitsPicker({
  threadId,
  model,
  cursorModelOptions,
}: {
  threadId: ThreadId;
  model: string | null | undefined;
  cursorModelOptions: CursorModelOptions | null;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const selection = parseCursorModelSelection(model, cursorModelOptions);
  const capability = getCursorModelCapabilities(selection.family);

  const showFastTrigger =
    capability.supportsFast &&
    cursorFamilySupportsFastWithReasoning(selection.family, selection.reasoning);

  const triggerLabel = [
    capability.supportsClaudeOpusTier
      ? selection.claudeOpusTier === "max"
        ? "Max"
        : "High"
      : null,
    capability.supportsReasoning ? CURSOR_REASONING_LABELS[selection.reasoning] : null,
    showFastTrigger && selection.fast ? "Fast" : null,
    capability.supportsThinking ? `Thinking ${selection.thinking ? "on" : "off"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (
    !capability.supportsReasoning &&
    !showFastTrigger &&
    !capability.supportsThinking &&
    !capability.supportsClaudeOpusTier
  ) {
    return null;
  }

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{triggerLabel.length > 0 ? triggerLabel : "Traits"}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <CursorTraitsMenuContent
          threadId={threadId}
          model={model}
          cursorModelOptions={cursorModelOptions}
        />
      </MenuPopup>
    </Menu>
  );
});
