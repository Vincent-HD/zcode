import type {
  OrchestrationV2ProviderTurn,
  ProviderInstanceId,
  UsageLimitsReport,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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

export const composerQuotaSummary = (accounts: UsageLimitsReport["accounts"]) =>
  accounts
    .flatMap((account) =>
      account.limits.windows.map((window) => `${window.label} ${window.usedPercent.toFixed(0)}%`),
    )
    .join(" · ") || "Quota unavailable";

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
