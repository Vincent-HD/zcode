import type { TurnTokenUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  estimateModelsDevCost,
  parseModelsDevPricing,
  resolveModelsDevPrice,
  type ModelsDevPrice,
} from "./models-dev-pricing";

const document = {
  openai: {
    models: {
      gpt: {
        id: "gpt",
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.2,
          cache_write: 3,
          tiers: [
            { input: 4, output: 20, cache_read: 0.4, tier: { type: "context", size: 1000 } },
            { input: 8, output: 40, tier: { type: "context", size: 2000 } },
          ],
        },
        experimental: {
          modes: {
            fast: { cost: { input: 6, output: 30 } },
            ultrafast: { cost: { input: 12, output: 60 } },
          },
        },
      },
      free: { id: "free", cost: { input: 0, output: 0 } },
      unpriced: { id: "unpriced" },
      incomplete: { id: "incomplete", cost: { input: 1 } },
      "anthropic/shared": { id: "anthropic/shared", cost: { input: 7, output: 9 } },
    },
  },
  anthropic: {
    models: {
      shared: { id: "shared", cost: { input: 3, output: 15 } },
      claude: { id: "claude", cost: { input: 3, output: 15 } },
    },
  },
  proxy: {
    models: {
      routed: { id: "routed", canonical_model_id: "openai/gpt", cost: { input: 99, output: 99 } },
    },
  },
};
const catalog = parseModelsDevPricing(document);
const resolve = (overrides: Partial<Parameters<typeof resolveModelsDevPrice>[0]> = {}) =>
  resolveModelsDevPrice({ catalog, model: "gpt", driver: "codex", contextTokens: 0, ...overrides });
const price: ModelsDevPrice = {
  provider: "openai",
  model: "gpt",
  fallback: null,
  mode: "standard",
  contextThreshold: null,
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 3,
  assumptions: [],
};
const complete: TurnTokenUsage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: 1000,
  outputTokens: 100,
  cachedInputTokens: 400,
  cacheCreationTokens: 200,
  reasoningTokens: 60,
  hasSubagents: false,
};

describe("parseModelsDevPricing", () => {
  it("validates pricing and ignores unrelated API metadata", () => {
    expect(
      parseModelsDevPricing({ openai: { ...document.openai, name: "OpenAI" } }),
    ).not.toBeNull();
    expect(catalog).not.toBeNull();
  });
  it.each([null, [], { openai: {} }, { openai: { models: { gpt: { id: 1 } } } }])(
    "rejects malformed document %j",
    (value) => {
      expect(parseModelsDevPricing(value)).toBeNull();
    },
  );
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "2", null])(
    "rejects invalid rates %s",
    (input) => {
      expect(
        parseModelsDevPricing({
          openai: { models: { gpt: { id: "gpt", cost: { input, output: 1 } } } },
        }),
      ).toBeNull();
    },
  );
});

describe("resolveModelsDevPrice", () => {
  it("maps native drivers and resolves explicit providers", () => {
    expect(resolve()).toMatchObject({ provider: "openai", model: "gpt", input: 2, fallback: null });
    expect(resolve({ driver: "claudeAgent", model: "claude" })).toMatchObject({
      provider: "anthropic",
      input: 3,
    });
    expect(resolve({ driver: null, model: "anthropic/claude" })).toMatchObject({
      provider: "anthropic",
      model: "claude",
    });
  });
  it("keeps an exact provider model containing a slash ahead of prefix interpretation", () => {
    expect(resolve({ model: "anthropic/shared" })).toMatchObject({
      provider: "openai",
      model: "anthropic/shared",
      input: 7,
    });
  });
  it("does not fall through a known provider or bare driver to another provider", () => {
    expect(resolve({ model: "openai/claude" })).toBeNull();
    expect(resolve({ model: "claude" })).toBeNull();
    expect(resolve({ model: "toString/gpt" })).toMatchObject({ fallback: "canonical-list-price" });
  });
  it("uses the canonical origin list price rather than a proxy markup", () => {
    expect(resolve({ driver: null, model: "custom/routed" })).toMatchObject({
      provider: "openai",
      model: "gpt",
      input: 2,
      fallback: "canonical-list-price",
    });
    expect(resolve({ driver: "proxy", model: "routed" })).toMatchObject({
      provider: "proxy",
      input: 99,
      fallback: null,
    });
  });
  it("rejects ambiguous canonical identities and missing canonical origins", () => {
    const ambiguous = parseModelsDevPricing({
      one: { models: { same: { id: "same", cost: { input: 1, output: 2 } } } },
      two: { models: { same: { id: "same", cost: { input: 2, output: 3 } } } },
    });
    expect(resolve({ catalog: ambiguous, model: "custom/same" })).toBeNull();
    const orphan = parseModelsDevPricing({ proxy: document.proxy });
    expect(resolve({ catalog: orphan, model: "custom/routed" })).toBeNull();
    expect(resolve({ model: "custom/missing" })).toBeNull();
  });
  it("resolves provider models by id as well as record key", () => {
    const byId = parseModelsDevPricing({
      openai: { models: { alias: { id: "actual", cost: { input: 1, output: 2 } } } },
    });
    expect(resolve({ catalog: byId, model: "actual" })).toMatchObject({ model: "actual" });
  });
  it("selects published speed modes with service tier precedence", () => {
    expect(resolve({ options: { serviceTier: "priority" } })).toMatchObject({
      mode: "fast",
      input: 6,
    });
    expect(resolve({ options: { fastMode: true } })).toMatchObject({ mode: "fast", input: 6 });
    expect(resolve({ options: { serviceTier: "ultrafast", fastMode: true } })).toMatchObject({
      mode: "ultrafast",
      input: 12,
    });
    expect(resolve({ options: { serviceTier: "flex" } })).toBeNull();
    expect(resolve({ model: "free", options: { fastMode: true } })).toBeNull();
  });
  it("uses only supplied context size and the highest exceeded threshold", () => {
    expect(resolve({ contextTokens: null })).toMatchObject({
      input: 2,
      contextThreshold: null,
      assumptions: ["context-tokens-unknown"],
    });
    expect(resolve({ contextTokens: 1000 })).toMatchObject({ input: 2, contextThreshold: null });
    expect(resolve({ contextTokens: 1001 })).toMatchObject({ input: 4, contextThreshold: 1000 });
    expect(resolve({ contextTokens: 2001 })).toMatchObject({ input: 8, contextThreshold: 2000 });
    expect(resolve({ contextTokens: -1 })).toBeNull();
  });
  it("does not apply standard context surcharges to unpublished fast context rates", () => {
    expect(resolve({ contextTokens: 1001, options: { serviceTier: "priority" } })).toBeNull();
    expect(resolve({ contextTokens: null, options: { serviceTier: "priority" } })).toMatchObject({
      mode: "fast",
      assumptions: ["context-tokens-unknown"],
    });
  });
  it("does not fill missing tier rates from standard pricing", () => {
    const incomplete = parseModelsDevPricing({
      openai: {
        models: {
          gpt: {
            id: "gpt",
            cost: {
              input: 2,
              output: 3,
              tiers: [{ input: 4, tier: { type: "context", size: 10 } }],
            },
          },
        },
      },
    });
    expect(resolve({ catalog: incomplete, contextTokens: 11 })).toBeNull();
  });
  it("keeps explicit free pricing distinct from absent pricing", () => {
    expect(resolve({ model: "free" })).toMatchObject({ input: 0, output: 0 });
    expect(resolve({ model: "unpriced" })).toBeNull();
    expect(resolve({ model: "incomplete" })).toBeNull();
    expect(resolve({ catalog: null })).toBeNull();
  });
});

describe("estimateModelsDevCost", () => {
  it("subtracts cache reads and writes from input and counts reasoning only once", () => {
    const result = estimateModelsDevCost({ price, usage: complete });
    expect(result).toMatchObject({
      inputUsd: 0.0008,
      outputUsd: 0.001,
      cacheReadUsd: 0.00008,
      cacheWriteUsd: 0.0006,
      partial: false,
      assumptions: [],
    });
    expect(result?.totalUsd).toBeCloseTo(0.00248, 12);
  });
  it("falls back to normal input rates for missing cache rates with explicit assumptions", () => {
    expect(
      estimateModelsDevCost({
        price: { ...price, cacheRead: null, cacheWrite: null },
        usage: complete,
      }),
    ).toMatchObject({
      cacheReadUsd: 0.0008,
      cacheWriteUsd: 0.0004,
      totalUsd: null,
      partial: true,
      assumptions: ["cache-read-rate-assumed-input", "cache-write-rate-assumed-input"],
    });
  });
  it("keeps missing cache counts visibly partial", () => {
    expect(
      estimateModelsDevCost({
        price,
        usage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 1000,
          outputTokens: 100,
          hasSubagents: false,
        },
      }),
    ).toMatchObject({
      totalUsd: null,
      partial: true,
      inputUsd: null,
      cacheReadUsd: null,
      cacheWriteUsd: null,
      assumptions: ["cache-read-tokens-unknown", "cache-write-tokens-unknown"],
    });
  });
  it("keeps partial usage split costs but never fabricates a full total", () => {
    expect(
      estimateModelsDevCost({ price, usage: { ...complete, usageStatus: "partial" } }),
    ).toMatchObject({ outputUsd: 0.001, totalUsd: null, partial: true });
    expect(
      estimateModelsDevCost({
        price,
        usage: {
          usageScope: "main_agent",
          usageStatus: "partial",
          outputTokens: 100,
          hasSubagents: false,
        },
      }),
    ).toMatchObject({
      inputUsd: null,
      outputUsd: 0.001,
      cacheReadUsd: null,
      cacheWriteUsd: null,
      totalUsd: null,
    });
  });
  it("preserves explicit zero rates and zero token counts", () => {
    expect(
      estimateModelsDevCost({
        price: { ...price, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        usage: complete,
      }),
    ).toMatchObject({ totalUsd: 0, partial: false });
    expect(
      estimateModelsDevCost({
        price,
        usage: {
          ...complete,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ).toMatchObject({ totalUsd: 0, partial: false });
  });
  it("never uses accumulated turn input to select a context tier", () => {
    expect(
      estimateModelsDevCost({
        price: resolve({ contextTokens: null }),
        usage: { ...complete, inputTokens: 1_000_000 },
      }),
    ).toMatchObject({ totalUsd: null, partial: true, assumptions: ["context-tokens-unknown"] });
  });
  it("returns null for unavailable, absent, inconsistent, or unsafe usage", () => {
    expect(estimateModelsDevCost({ price, usage: undefined })).toBeNull();
    expect(estimateModelsDevCost({ price: null, usage: complete })).toBeNull();
    expect(
      estimateModelsDevCost({ price, usage: { ...complete, usageStatus: "unavailable" } }),
    ).toBeNull();
    expect(estimateModelsDevCost({ price, usage: { ...complete, inputTokens: 100 } })).toBeNull();
    expect(estimateModelsDevCost({ price, usage: { ...complete, outputTokens: 50 } })).toBeNull();
    expect(
      estimateModelsDevCost({
        price,
        usage: { ...complete, inputTokens: Number.POSITIVE_INFINITY },
      }),
    ).toBeNull();
    expect(
      estimateModelsDevCost({ price: { ...price, output: Number.MAX_VALUE }, usage: complete }),
    ).toBeNull();
  });
});
