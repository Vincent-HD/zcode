import { assert, describe, it } from "@effect/vitest";
import type { RunResult } from "@cursor/sdk";
import { cursorTurnTokenUsage } from "./turn-usage.ts";

const usage = {
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 60,
  cacheWriteTokens: 20,
  reasoningTokens: 10,
  totalTokens: 220,
};

describe("cursorTurnTokenUsage", () => {
  it("normalizes cache and reasoning without counting them twice", () => {
    assert.deepEqual(
      cursorTurnTokenUsage({
        usage,
        status: "completed",
        hasSubagents: true,
        hasMissingUsage: false,
      }),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 180,
        outputTokens: 40,
        cachedInputTokens: 60,
        cacheCreationTokens: 20,
        reasoningTokens: 10,
        hasSubagents: true,
      },
    );
  });

  it.each(["interrupted", "failed", "cancelled"] as const)(
    "marks reported usage as partial for %s responses",
    (status) => {
      const report = cursorTurnTokenUsage({
        usage,
        status,
        hasSubagents: false,
        hasMissingUsage: false,
      });
      assert.equal(report.usageStatus, "partial");
      assert.equal(report.outputTokens, 40);
    },
  );

  it("keeps incomplete run coverage partial even when the run succeeds", () => {
    assert.equal(
      cursorTurnTokenUsage({
        usage,
        status: "completed",
        hasSubagents: false,
        hasMissingUsage: true,
      }).usageStatus,
      "partial",
    );
  });

  it.each<RunResult["usage"]>([
    undefined,
    { ...usage, inputTokens: -1 },
    { ...usage, cacheReadTokens: -1 },
    { ...usage, outputTokens: NaN },
    { ...usage, cacheWriteTokens: 1.5 },
    { ...usage, reasoningTokens: 41 },
  ])("keeps missing or invalid counts unavailable (%j)", (reported) => {
    assert.deepEqual(
      cursorTurnTokenUsage({
        usage: reported,
        status: "completed",
        hasSubagents: false,
        hasMissingUsage: false,
      }),
      { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
    );
  });

  it("preserves reported zeroes and absent reasoning", () => {
    const report = cursorTurnTokenUsage({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      status: "completed",
      hasSubagents: false,
      hasMissingUsage: false,
    });
    assert.equal(report.usageStatus, "complete");
    assert.equal(report.inputTokens, 0);
    assert.equal(report.outputTokens, 0);
    assert.notProperty(report, "reasoningTokens");
  });
});
