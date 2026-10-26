import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderTurnId,
  ProviderThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { resolveUsageTurn } from "./turn-usage.logic";
import {
  parseModelsDevPricing,
  estimateModelsDevCost,
  resolveModelsDevPrice,
} from "./models-dev-pricing";
import { priceUsageTurn, sessionPricing } from "./usage-pricing";

const instance = ProviderInstanceId.make("custom-codex");
const nodeId = NodeId.make("old-turn-node");
const runId = RunId.make("old-run");
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("old-turn"),
  providerThreadId: ProviderThreadId.make("thread"),
  nodeId,
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: null,
  completedAt: null,
  turnTokenUsage: {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 400,
    hasSubagents: false,
  },
};
const selection = { instanceId: instance, model: "old-model" };
const projection = {
  providerTurns: [turn],
  nodes: [{ id: nodeId, runId }],
  runs: [
    { id: runId, modelSelection: selection, providerInstanceId: instance },
    {
      id: RunId.make("latest"),
      modelSelection: { instanceId: instance, model: "new-model" },
      providerInstanceId: instance,
    },
  ],
  providerThreads: [
    {
      id: turn.providerThreadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instance,
    },
  ],
};
const catalog = parseModelsDevPricing({
  openai: {
    models: {
      "old-model": { id: "old-model", cost: { input: 2, output: 10, cache_read: 0.2 } },
      "new-model": { id: "new-model", cost: { input: 100, output: 100 } },
    },
  },
});

describe("historical turn usage", () => {
  it("uses the recorded run model rather than a later model selection", () => {
    const data = resolveUsageTurn({ projection, providerTurnId: turn.id });
    expect(data?.selection).toEqual(selection);
    expect(data?.driver).toBe("codex");
    if (!data) throw new Error("Expected recorded turn");
    expect(priceUsageTurn({ catalog, data }).cost?.estimatedUsd).toBeCloseTo(0.00228, 12);
  });
  it("uses the source message run when its node is not loaded", () => {
    expect(
      resolveUsageTurn({ projection: { ...projection, nodes: [] }, providerTurnId: turn.id, runId })
        ?.selection,
    ).toEqual(selection);
  });
  it("leaves missing historical selections unpriced", () => {
    const data = resolveUsageTurn({
      projection: { ...projection, runs: [] },
      providerTurnId: turn.id,
    });
    expect(data?.selection).toBeNull();
    if (!data) throw new Error("Expected recorded turn");
    expect(priceUsageTurn({ catalog, data }).cost).toBeNull();
    expect(
      resolveUsageTurn({ projection, providerTurnId: ProviderTurnId.make("unknown") }),
    ).toBeNull();
  });
  it("prices mixed-model sessions turn by turn and reports unpriced coverage", () => {
    const first = { turn, selection, driver: "codex", providerLabel: instance };
    const second = { ...first, selection: { instanceId: instance, model: "new-model" } };
    const unpriced = { ...first, selection: null };
    const result = sessionPricing({
      catalog,
      turns: [first, second, unpriced, { ...first, turn: { ...turn, status: "running" } }],
    });
    expect(result.pricedTurns).toBe(2);
    expect(result.completedTurns).toBe(3);
    expect(result.partial).toBe(true);
    expect(result.totalUsd).toBeCloseTo(0.11228, 12);
  });
  it("keeps unknown cache assumptions visible while providing approximate complete-turn costs", () => {
    const price = resolveModelsDevPrice({ catalog, model: "old-model", driver: "codex" });
    const result = estimateModelsDevCost({ price, usage: turn.turnTokenUsage });
    expect(result?.estimatedUsd).toBeCloseTo(0.00228, 12);
    expect(result?.totalUsd).toBeNull();
    expect(result?.assumptions).toContain("cache-write-tokens-unknown");
    expect(
      estimateModelsDevCost({ price, usage: { ...turn.turnTokenUsage!, usageStatus: "partial" } })
        ?.estimatedUsd,
    ).toBeNull();
  });
});
