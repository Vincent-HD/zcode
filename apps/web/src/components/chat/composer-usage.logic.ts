import type {
  OrchestrationV2ProviderTurn,
  ProviderInstanceId,
  UsageLimitsReport,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { remainingPercent } from "@t3tools/shared/usageLimits";

const compactCountFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumSignificantDigits: 3,
  maximumFractionDigits: 1,
  roundingPriority: "lessPrecision",
});

export const compactTokenCount = (value: number | null | undefined) =>
  value == null ? "N/A" : compactCountFormatter.format(value);

export const selectComposerUsageAccounts = (
  accounts: UsageLimitsReport["accounts"],
  instanceId: ProviderInstanceId | null,
): UsageLimitsReport["accounts"] =>
  instanceId === null
    ? []
    : accounts.filter(
        (account) => account.instanceId === instanceId || account.instanceId === undefined,
      );

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

const WINDOW_DURATION_LABEL =
  /^(?:session|daily|weekly|monthly|(?:\d+(?:\.\d+)?|five|seven|thirty)[\s-]*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?))$/i;
const TRAILING_WINDOW_DURATION =
  /(?:\s+|\s*\()(?:\d+(?:\.\d+)?[\s-]*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?))\s*\)?$/i;

const formatWindowDuration = (minutes: number) => {
  if (minutes >= MINUTES_PER_WEEK && minutes % MINUTES_PER_DAY === 0) {
    return `${minutes / MINUTES_PER_DAY}d`;
  }
  if (minutes >= MINUTES_PER_HOUR && minutes % MINUTES_PER_HOUR === 0) {
    return `${minutes / MINUTES_PER_HOUR}h`;
  }
  if (minutes >= MINUTES_PER_HOUR) {
    return `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${minutes % MINUTES_PER_HOUR}m`;
  }
  return `${minutes}m`;
};

const compactWindowLabel = (
  window: UsageLimitsReport["accounts"][number]["limits"]["windows"][number],
) => {
  if (window.windowDurationMins === undefined) return window.label.trim();

  const duration = formatWindowDuration(window.windowDurationMins);
  const name = window.label
    .trim()
    .split(/\s*[·|]\s*/)
    .filter((part) => !WINDOW_DURATION_LABEL.test(part.trim()))
    .join(" · ")
    .replace(/^(?:session|daily|weekly|monthly)\s+/i, "")
    .replace(/\s+(?:session|daily|weekly|monthly)$/i, "")
    .replace(TRAILING_WINDOW_DURATION, "")
    .trim();
  return name ? `${name} ${duration}` : duration;
};

const accountSummaryName = (account: UsageLimitsReport["accounts"][number]) =>
  account.displayName?.trim() || account.label || String(account.driver);

const accountSummaryNames = (accounts: UsageLimitsReport["accounts"]) => {
  const baseNames = accounts.map(accountSummaryName);
  const baseNameCounts = new Map<string, number>();
  for (const name of baseNames) {
    baseNameCounts.set(name, (baseNameCounts.get(name) ?? 0) + 1);
  }

  const names = accounts.map((account, index) => {
    const baseName = baseNames[index]!;
    const label = account.label.trim();
    return (baseNameCounts.get(baseName) ?? 0) > 1 && label && label !== baseName
      ? label
      : baseName;
  });
  const nameCounts = new Map<string, number>();
  for (const name of names) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return names.map((name, index) =>
    (nameCounts.get(name) ?? 0) > 1 ? `${name} (${accounts[index]!.id})` : name,
  );
};

export const composerQuotaSummary = (accounts: UsageLimitsReport["accounts"]) => {
  const accountNames = accountSummaryNames(accounts);
  const includeAccountName = accounts.length > 1;
  const rows = accounts.flatMap((account, accountIndex) => {
    const accountName = accountNames[accountIndex]!;
    const windowNames = account.limits.windows.map(compactWindowLabel);
    const windowNameCounts = new Map<string, number>();
    for (const name of windowNames)
      windowNameCounts.set(name, (windowNameCounts.get(name) ?? 0) + 1);

    return account.limits.windows.map((window, index) => {
      const baseWindowName = windowNames[index]!;
      const windowName =
        (windowNameCounts.get(baseWindowName) ?? 0) > 1
          ? `${baseWindowName} (${window.id})`
          : baseWindowName;
      const name = includeAccountName ? `${accountName} ${windowName}` : windowName;
      return `${name} ${remainingPercent(window)}%`;
    });
  });

  return rows.join(" · ") || "Quota unavailable";
};

export type CompletedUsageTurn = Pick<
  OrchestrationV2ProviderTurn,
  "status" | "startedAt" | "completedAt" | "turnTokenUsage"
>;

export const completedTurnDuration = (turn: CompletedUsageTurn | null) => {
  if (!turn || turn.status !== "completed" || !turn.startedAt || !turn.completedAt) return null;
  const elapsedMs =
    DateTime.toEpochMillis(turn.completedAt) - DateTime.toEpochMillis(turn.startedAt);
  return elapsedMs >= 0 ? elapsedMs : null;
};

export const lastResponseUsage = (turn: CompletedUsageTurn | null) => {
  const usage = turn?.turnTokenUsage;
  if (!turn || turn.status !== "completed" || !usage || usage.usageStatus === "unavailable") {
    return null;
  }
  const elapsedMs = completedTurnDuration(turn);
  return {
    durationMs: elapsedMs,
    cacheCreationTokens: usage.cacheCreationTokens ?? null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    partial: usage.usageStatus === "partial",
    hasSubagents: usage.hasSubagents,
    tokensPerSecond:
      usage.usageStatus === "complete" &&
      usage.outputTokens !== undefined &&
      elapsedMs !== null &&
      elapsedMs > 0
        ? (usage.outputTokens * 1000) / elapsedMs
        : null,
  };
};

export const formatUsageDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return "N/A";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

export const sessionUsage = (turns: ReadonlyArray<CompletedUsageTurn>) => {
  const completed = turns.filter((turn) => turn.status === "completed");
  const reports = completed.map(lastResponseUsage).filter((usage) => usage !== null);
  const sum = (
    field: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheCreationTokens",
  ) => {
    const values = reports.map((report) => report[field]).filter((value) => value !== null);
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
  };
  const inputTokens = sum("inputTokens");
  const outputTokens = sum("outputTokens");
  const cachedInputTokens = sum("cachedInputTokens");
  const cacheCreationTokens = sum("cacheCreationTokens");
  const completeCacheCoverage =
    reports.length > 0 &&
    reports.length === completed.length &&
    reports.every(
      (report) =>
        !report.partial && report.inputTokens !== null && report.cachedInputTokens !== null,
    );
  const durations = completed.map(completedTurnDuration).filter((duration) => duration !== null);
  return {
    turns: completed.length,
    reportedTurns: reports.length,
    partial:
      reports.length !== completed.length ||
      reports.some(
        (report) => report.partial || report.inputTokens === null || report.outputTokens === null,
      ),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    uncachedInputTokens:
      inputTokens !== null &&
      cachedInputTokens !== null &&
      completeCacheCoverage &&
      inputTokens >= cachedInputTokens
        ? inputTokens - cachedInputTokens
        : null,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    cacheHitPercent:
      inputTokens !== null &&
      inputTokens > 0 &&
      cachedInputTokens !== null &&
      completeCacheCoverage &&
      cachedInputTokens <= inputTokens
        ? (cachedInputTokens / inputTokens) * 100
        : null,
    durationMs:
      durations.length === completed.length && durations.length > 0
        ? durations.reduce((total, duration) => total + duration, 0)
        : null,
  };
};

export const toolUsageDuration = (
  calls: ReadonlyArray<{
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
  }>,
) => {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const call of calls) {
    if (!call.startedAt || !call.completedAt) return null;
    const start = DateTime.toEpochMillis(call.startedAt);
    const end = DateTime.toEpochMillis(call.completedAt);
    if (end < start) return null;
    intervals.push({ start, end });
  }
  intervals.sort((left, right) => left.start - right.start);
  let total = 0;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    total += Math.max(0, interval.end - Math.max(interval.start, previousEnd));
    previousEnd = Math.max(previousEnd, interval.end);
  }
  return total;
};
