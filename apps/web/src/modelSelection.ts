import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  getModelOptions,
  normalizeModelSlug,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import { getComposerProviderState } from "./components/chat/composerProviderRegistry";
import { UnifiedSettings } from "./appSettings";

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;

export type ProviderCustomModelConfig = {
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
};

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const PROVIDER_CUSTOM_MODEL_CONFIG: Record<ProviderKind, ProviderCustomModelConfig> = {
  codex: {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
};

const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  claudeAgent: new Set(getModelOptions("claudeAgent").map((option) => option.slug)),
};

export const MODEL_PROVIDER_SETTINGS = Object.values(PROVIDER_CUSTOM_MODEL_CONFIG);

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  provider: ProviderKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));
  const trimmedSelectedModel = selectedModel?.trim().toLowerCase();

  const customModels = settings.providers[provider].customModels;
  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  const selectedModelMatchesExistingName =
    typeof trimmedSelectedModel === "string" &&
    options.some((option) => option.name.toLowerCase() === trimmedSelectedModel);
  if (
    normalizedSelectedModel &&
    !seen.has(normalizedSelectedModel) &&
    !selectedModelMatchesExistingName
  ) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  settings: UnifiedSettings,

  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(settings, provider, selectedModel);
  return resolveSelectableModel(provider, selectedModel, options) ?? getDefaultModel(provider);
}

export function getCustomModelOptionsByProvider(
  settings: UnifiedSettings,
  selectedProvider?: ProviderKind | null,
  selectedModel?: string | null,
): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  return {
    codex: getAppModelOptions(
      settings,
      "codex",
      selectedProvider === "codex" ? selectedModel : undefined,
    ),
    claudeAgent: getAppModelOptions(
      settings,
      "claudeAgent",
      selectedProvider === "claudeAgent" ? selectedModel : undefined,
    ),
  };
}

export function resolveAppModelSelectionState(settings: UnifiedSettings): ModelSelection {
  const selection = settings.textGenerationModelSelection ?? {
    provider: "codex" as const,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  };

  const model = resolveAppModelSelection(selection.provider, settings, selection.model);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider: selection.provider,
    model,
    prompt: "",
    modelOptions: {
      [selection.provider]: selection.options,
    },
  });

  return {
    provider: selection.provider,
    model,
    ...(modelOptionsForDispatch ? { options: modelOptionsForDispatch } : {}),
  };
}
