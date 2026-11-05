import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  composerQuotaSummary,
  compactTokenCount,
  completedTurnDuration,
  lastResponseUsage,
  selectComposerUsageAccounts,
  sessionUsage,
  toolUsageDuration,
  formatUsageDuration,
  type CompletedUsageTurn,
} from "./composer-usage.logic";
import { ProviderDriverKind, ProviderInstanceId, type UsageLimitsReport } from "@t3tools/contracts";

describe("compactTokenCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [134351, "134K"],
    [5173243, "5.2M"],
    [1300000000, "1.3B"],
    [999999, "1M"],
    [1000000000000, "1T"],
    [null, "N/A"],
    [undefined, "N/A"],
  ])("formats %s as %s", (value, expected) => {
    expect(compactTokenCount(value)).toBe(expected);
  });
});

describe("composer quota selection", () => {
  const selectedInstanceId = ProviderInstanceId.make("codex-personal");
  const otherInstanceId = ProviderInstanceId.make("codex-work");
  const driver = ProviderDriverKind.make("codex");
  const unavailable = {
    checkedAt: "2026-10-14T11:05:28.387Z",
    windows: [],
    unavailable: {
      reason: "unsupported" as const,
      message: "ChatGPT tracks subscription usage across connected apps.",
    },
  };
  const selected = {
    id: "codex-personal",
    driver,
    label: "Evvi",
    instanceId: selectedInstanceId,
    limits: unavailable,
  } satisfies UsageLimitsReport["accounts"][number];
  const other = {
    ...selected,
    id: "codex-work",
    label: "Work",
    instanceId: otherInstanceId,
  } satisfies UsageLimitsReport["accounts"][number];
  const source = {
    id: "proxy:codex-seat",
    driver,
    label: "CLI Proxy · Codex seat",
    limits: {
      checkedAt: unavailable.checkedAt,
      windows: [
        {
          id: "weekly",
          kind: "weekly" as const,
          label: "Weekly",
          usedPercent: 42,
        },
      ],
    },
  } satisfies UsageLimitsReport["accounts"][number];

  it("keeps the selected native account and source accounts, excluding other instances", () => {
    expect(selectComposerUsageAccounts([other, selected, source], selectedInstanceId)).toEqual([
      selected,
      source,
    ]);
    expect(selectComposerUsageAccounts([other, selected], null)).toEqual([]);
  });

  it("reports unavailable quota data without implying the authenticated account is unavailable", () => {
    expect(composerQuotaSummary([selected])).toBe("Quota unavailable");
    expect(composerQuotaSummary([source])).toBe("Weekly 58%");
  });

  it("uses reported durations, keeps named counters, and leaves missing durations named", () => {
    const account = {
      ...selected,
      limits: {
        checkedAt: unavailable.checkedAt,
        windows: [
          {
            id: "five-hour",
            kind: "session" as const,
            label: "Session",
            usedPercent: 12,
            windowDurationMins: 300,
          },
          {
            id: "daily",
            kind: "other" as const,
            label: "Daily",
            usedPercent: 18,
            windowDurationMins: 1440,
          },
          {
            id: "fractional-hour",
            kind: "other" as const,
            label: "Custom quota",
            usedPercent: 40,
            windowDurationMins: 90,
          },
          {
            id: "sonnet",
            kind: "weekly" as const,
            label: "Weekly Sonnet",
            usedPercent: 12,
            windowDurationMins: 10080,
          },
          { id: "spend", kind: "monthly" as const, label: "Monthly spend", usedPercent: 23 },
        ],
      },
    } satisfies UsageLimitsReport["accounts"][number];

    expect(composerQuotaSummary([account])).toBe(
      "5h 88% · 24h 82% · Custom quota 1h 30m 60% · Sonnet 7d 88% · Monthly spend 77%",
    );
  });

  it("names multiple accounts and separates same-duration windows", () => {
    const personal = {
      ...source,
      id: "proxy:personal",
      label: "Proxy · personal",
      displayName: "Claude",
      limits: {
        checkedAt: unavailable.checkedAt,
        windows: [
          {
            id: "sonnet",
            kind: "weekly" as const,
            label: "Weekly · Sonnet",
            usedPercent: 12,
            windowDurationMins: 10080,
          },
          {
            id: "opus",
            kind: "weekly" as const,
            label: "Weekly · Opus",
            usedPercent: 9,
            windowDurationMins: 10080,
          },
        ],
      },
    } satisfies UsageLimitsReport["accounts"][number];
    const work = {
      ...source,
      id: "proxy:work",
      label: "Proxy · work",
      displayName: "Claude",
      limits: {
        checkedAt: unavailable.checkedAt,
        windows: [
          {
            id: "weekly",
            kind: "weekly" as const,
            label: "Claude & GPT (shared) · Weekly",
            usedPercent: 42,
            windowDurationMins: 10080,
          },
        ],
      },
    } satisfies UsageLimitsReport["accounts"][number];

    expect(composerQuotaSummary([personal, work])).toBe(
      "Proxy · personal Sonnet 7d 88% · Proxy · personal Opus 7d 91% · Proxy · work Claude & GPT (shared) 7d 58%",
    );

    const sameLabel = [
      { ...personal, id: "proxy:first", label: "Proxy · team" },
      { ...work, id: "proxy:second", label: "Proxy · team" },
    ];
    expect(composerQuotaSummary(sameLabel)).toBe(
      "Proxy · team (proxy:first) Sonnet 7d 88% · Proxy · team (proxy:first) Opus 7d 91% · Proxy · team (proxy:second) Claude & GPT (shared) 7d 58%",
    );
  });

  it("uses a window id only when otherwise identical windows collide", () => {
    const account = {
      ...selected,
      limits: {
        checkedAt: unavailable.checkedAt,
        windows: [
          {
            id: "primary",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: 12,
            windowDurationMins: 10080,
          },
          {
            id: "secondary",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: 34,
            windowDurationMins: 10080,
          },
        ],
      },
    } satisfies UsageLimitsReport["accounts"][number];

    expect(composerQuotaSummary([account])).toBe("7d (primary) 88% · 7d (secondary) 66%");
  });
});

const completed: CompletedUsageTurn = {
  status: "completed",
  startedAt: DateTime.makeUnsafe("2026-10-12T12:00:00Z"),
  completedAt: DateTime.makeUnsafe("2026-10-12T12:00:10Z"),
  turnTokenUsage: {
    usageStatus: "complete",
    usageScope: "main_agent",
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 500,
    hasSubagents: true,
  },
};

describe("completedTurnDuration", () => {
  it("retains timing without token usage", () => {
    expect(completedTurnDuration({ ...completed, turnTokenUsage: undefined })).toBe(10000);
    expect(
      completedTurnDuration({
        ...completed,
        turnTokenUsage: {
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: false,
        },
      }),
    ).toBe(10000);
  });
  it("rejects incomplete and reversed timing", () => {
    expect(completedTurnDuration(null)).toBeNull();
    expect(completedTurnDuration({ ...completed, status: "running" })).toBeNull();
    expect(completedTurnDuration({ ...completed, startedAt: null })).toBeNull();
    expect(
      completedTurnDuration({
        ...completed,
        startedAt: completed.completedAt,
        completedAt: completed.startedAt,
      }),
    ).toBeNull();
  });
});

describe("lastResponseUsage", () => {
  it("uses main-agent output over the full turn duration", () => {
    expect(lastResponseUsage(completed)).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 500,
      tokensPerSecond: 20,
      hasSubagents: true,
      partial: false,
    });
  });
  it("does not invent usage for missing reports or running turns", () => {
    expect(lastResponseUsage(null)).toBeNull();
    expect(lastResponseUsage({ ...completed, turnTokenUsage: undefined })).toBeNull();
    expect(lastResponseUsage({ ...completed, status: "running" })).toBeNull();
  });
  it("omits speed for missing, zero or reversed durations", () => {
    expect(lastResponseUsage({ ...completed, startedAt: null })?.tokensPerSecond).toBeNull();
    expect(
      lastResponseUsage({ ...completed, completedAt: completed.startedAt })?.tokensPerSecond,
    ).toBeNull();
    expect(
      lastResponseUsage({
        ...completed,
        startedAt: completed.completedAt,
        completedAt: completed.startedAt,
      })?.tokensPerSecond,
    ).toBeNull();
  });
  it("keeps partial counts visible without presenting partial usage as throughput", () => {
    expect(
      lastResponseUsage({
        ...completed,
        turnTokenUsage: {
          usageStatus: "partial",
          usageScope: "main_agent",
          inputTokens: 10,
          hasSubagents: false,
        },
      }),
    ).toMatchObject({ inputTokens: 10, outputTokens: null, partial: true, tokensPerSecond: null });
  });
});

describe("sessionUsage", () => {
  it("sums completed main-agent turns without double counting reasoning or cache subsets", () => {
    const turn = {
      ...completed,
      turnTokenUsage: {
        ...completed.turnTokenUsage!,
        cacheCreationTokens: 100,
        reasoningTokens: 50,
      },
    };
    expect(sessionUsage([turn, turn, { ...turn, status: "running" }])).toMatchObject({
      turns: 2,
      totalTokens: 2400,
      inputTokens: 2000,
      outputTokens: 400,
      cachedInputTokens: 1000,
      uncachedInputTokens: 1000,
      cacheCreationTokens: 200,
      cacheHitPercent: 50,
      durationMs: 20000,
      partial: false,
    });
  });
  it("retains known totals but suppresses cache ratios when a turn is missing usage", () => {
    expect(sessionUsage([completed, { ...completed, turnTokenUsage: undefined }])).toMatchObject({
      turns: 2,
      reportedTurns: 1,
      totalTokens: 1200,
      partial: true,
      cacheHitPercent: null,
      uncachedInputTokens: null,
    });
    expect(sessionUsage([])).toMatchObject({
      totalTokens: null,
      cacheHitPercent: null,
      durationMs: null,
    });
  });
  it("does not treat unreported cache counts as zero", () => {
    expect(
      sessionUsage([
        {
          ...completed,
          turnTokenUsage: { ...completed.turnTokenUsage!, cachedInputTokens: undefined },
        },
      ]),
    ).toMatchObject({ cachedInputTokens: null, uncachedInputTokens: null, cacheHitPercent: null });
  });
});

describe("toolUsageDuration", () => {
  const time = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);
  it("counts overlapping and nested tool intervals once", () => {
    expect(
      toolUsageDuration([
        { startedAt: time(0), completedAt: time(10) },
        { startedAt: time(2), completedAt: time(4) },
        { startedAt: time(5), completedAt: time(15) },
        { startedAt: time(20), completedAt: time(25) },
      ]),
    ).toBe(20000);
  });
  it("omits tool time when timestamps are missing or reversed", () => {
    expect(toolUsageDuration([{ startedAt: null, completedAt: time(5) }])).toBeNull();
    expect(toolUsageDuration([{ startedAt: time(5), completedAt: time(0) }])).toBeNull();
    expect(toolUsageDuration([])).toBe(0);
  });
});

it("formats compact session durations", () => {
  expect(formatUsageDuration(245000)).toBe("4m 5s");
  expect(formatUsageDuration(3660000)).toBe("1h 1m");
  expect(formatUsageDuration(null)).toBe("N/A");
});
