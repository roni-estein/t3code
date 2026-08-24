import type { ProviderPlanUsage, ProviderPlanUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedPercent(value: unknown): number | null {
  const percent = asFiniteNumber(value);
  return percent === null ? null : Math.max(0, Math.min(100, percent));
}

function isoFromUnixSeconds(value: unknown): string | null {
  const seconds = asFiniteNumber(value);
  if (seconds === null) return null;
  return Option.match(DateTime.make(seconds * 1_000), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function isoFromString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function codexDurationLabel(durationMinutes: number | null, role: "primary" | "secondary") {
  if (durationMinutes === 5 * 60) return "5-hour";
  if (durationMinutes === 7 * 24 * 60) return "Weekly";
  if (durationMinutes !== null && durationMinutes > 0 && durationMinutes % 60 === 0) {
    return `${durationMinutes / 60}-hour`;
  }
  return role === "primary" ? "Primary" : "Secondary";
}

function codexWindows(
  bucket: UnknownRecord,
  bucketId: string,
  includeBucketLabel: boolean,
): ProviderPlanUsageWindow[] {
  const bucketLabel =
    typeof bucket.limitName === "string" && bucket.limitName.trim()
      ? bucket.limitName.trim()
      : bucketId;
  const windows: ProviderPlanUsageWindow[] = [];

  for (const role of ["primary", "secondary"] as const) {
    const window = asRecord(bucket[role]);
    if (!window) continue;
    const usedPercent = normalizedPercent(window.usedPercent);
    if (usedPercent === null) continue;
    const durationMinutes = asFiniteNumber(window.windowDurationMins);
    const windowLabel = codexDurationLabel(durationMinutes, role);
    windows.push({
      id: `${bucketId}:${role}`,
      label: includeBucketLabel ? `${bucketLabel} · ${windowLabel}` : windowLabel,
      usedPercent,
      resetsAt: isoFromUnixSeconds(window.resetsAt),
      ...(durationMinutes !== null && durationMinutes >= 0
        ? { windowDurationMinutes: Math.floor(durationMinutes) }
        : {}),
    });
  }

  return windows;
}

/** Normalize Codex app-server's multi-bucket rate-limit response. */
export function normalizeCodexPlanUsage(
  value: unknown,
  checkedAt: string,
): ProviderPlanUsage | undefined {
  const response = asRecord(value);
  if (!response) return undefined;
  const byLimitId = asRecord(response.rateLimitsByLimitId);
  const entries = byLimitId
    ? Object.entries(byLimitId).flatMap(([id, bucket]) => {
        const record = asRecord(bucket);
        return record ? ([[id, record]] as const) : [];
      })
    : [];
  const fallback = asRecord(response.rateLimits);
  const buckets =
    entries.length > 0
      ? entries
      : fallback
        ? ([[typeof fallback.limitId === "string" ? fallback.limitId : "codex", fallback]] as const)
        : [];
  const windows = buckets.flatMap(([id, bucket]) => {
    const limitName = typeof bucket.limitName === "string" ? bucket.limitName.trim() : "";
    const isDefaultBucket = id.toLowerCase() === "codex" || limitName.toLowerCase() === "codex";
    return codexWindows(bucket, id, buckets.length > 1 && !isDefaultBucket);
  });
  return windows.length > 0 ? { checkedAt, windows } : undefined;
}

const CLAUDE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "Current session",
  seven_day: "All models",
  seven_day_fable: "Fable",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  seven_day_oauth_apps: "OAuth apps",
};

const CLAUDE_WINDOW_ORDER = [
  "five_hour",
  "seven_day",
  "seven_day_fable",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const;

function claudeWindowLabel(id: string): string {
  const known = CLAUDE_WINDOW_LABELS[id];
  if (known) return known;
  return id
    .replace(/^seven_day_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function claudeLimitEntryId(value: UnknownRecord): string | null {
  const kind = typeof value.kind === "string" ? value.kind : null;
  const group = typeof value.group === "string" ? value.group : null;
  if (kind === "session" || (group === "session" && !value.scope)) return "five_hour";
  if (kind === "weekly_all" || (group === "weekly" && !value.scope)) return "seven_day";
  if (kind !== "weekly_scoped" && group !== "weekly") return null;
  const scope = asRecord(value.scope);
  const model = asRecord(scope?.model);
  const modelName =
    typeof model?.display_name === "string"
      ? model.display_name
      : typeof model?.id === "string"
        ? model.id
        : "";
  return /fable/i.test(modelName) ? "seven_day_fable" : null;
}

function claudeWindowFromRecord(id: string, window: UnknownRecord): ProviderPlanUsageWindow | null {
  const usedPercent = [
    window.utilization,
    window.used_percentage,
    window.usedPercentage,
    window.percent,
  ].reduce<number | null>((found, candidate) => found ?? normalizedPercent(candidate), null);
  if (usedPercent === null) return null;
  const resetsAt = [window.resets_at, window.resetsAt, window.reset_at, window.resetAt].reduce<
    string | null
  >((found, candidate) => found ?? isoFromString(candidate), null);
  return {
    id,
    label: claudeWindowLabel(id),
    usedPercent,
    resetsAt,
    ...(id === "five_hour"
      ? { windowDurationMinutes: 5 * 60 }
      : id.startsWith("seven_day")
        ? { windowDurationMinutes: 7 * 24 * 60 }
        : {}),
  };
}

/** Normalize Claude's structured OAuth usage windows. */
export function normalizeClaudePlanUsage(
  value: unknown,
  checkedAt: string,
): ProviderPlanUsage | undefined {
  const rateLimits = asRecord(value);
  if (!rateLimits) return undefined;
  const orderedKeys = [
    ...CLAUDE_WINDOW_ORDER,
    ...Object.keys(rateLimits)
      .filter((key) => !CLAUDE_WINDOW_ORDER.includes(key as (typeof CLAUDE_WINDOW_ORDER)[number]))
      .sort(),
  ];
  const windows: ProviderPlanUsageWindow[] = [];

  for (const id of orderedKeys) {
    if (id === "extra_usage" || id === "limits") continue;
    const window = asRecord(rateLimits[id]);
    if (!window) continue;
    const normalized = claudeWindowFromRecord(id, window);
    if (normalized) windows.push(normalized);
  }

  if (Array.isArray(rateLimits.limits)) {
    for (const value of rateLimits.limits) {
      const window = asRecord(value);
      if (!window) continue;
      const id = claudeLimitEntryId(window);
      if (!id) continue;
      const normalized = claudeWindowFromRecord(id, window);
      if (!normalized) continue;
      const existingIndex = windows.findIndex((candidate) => candidate.id === id);
      if (existingIndex === -1) windows.push(normalized);
      else windows[existingIndex] = normalized;
    }
  }

  windows.sort((left, right) => {
    const leftIndex = CLAUDE_WINDOW_ORDER.indexOf(left.id as (typeof CLAUDE_WINDOW_ORDER)[number]);
    const rightIndex = CLAUDE_WINDOW_ORDER.indexOf(
      right.id as (typeof CLAUDE_WINDOW_ORDER)[number],
    );
    return (
      (leftIndex === -1 ? CLAUDE_WINDOW_ORDER.length : leftIndex) -
      (rightIndex === -1 ? CLAUDE_WINDOW_ORDER.length : rightIndex)
    );
  });
  return windows.length > 0 ? { checkedAt, windows } : undefined;
}
