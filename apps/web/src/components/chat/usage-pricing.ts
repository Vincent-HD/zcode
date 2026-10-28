import {
  estimateModelsDevCost,
  resolveModelsDevPrice,
  type ModelsDevCatalog,
} from "./models-dev-pricing";
import type { UsageTurn } from "./turn-usage.logic";

const dollarFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
export const usageDollars = (value: number | null | undefined) =>
  value == null ? "N/A" : dollarFormatter.format(value);

export const priceUsageTurn = (input: {
  readonly catalog: ModelsDevCatalog | null;
  readonly data: UsageTurn;
}) => {
  const selection = input.data.selection;
  const price = selection
    ? resolveModelsDevPrice({
        catalog: input.catalog,
        model: selection.model,
        driver: input.data.driver,
        options: Object.fromEntries(
          (selection.options ?? []).map((option) => [option.id, option.value]),
        ),
        contextTokens: input.data.turn.tokenUsage?.usedTokens ?? null,
      })
    : null;
  const cost = estimateModelsDevCost({ price, usage: input.data.turn.turnTokenUsage });
  return { price, cost };
};

export const sessionPricing = (input: {
  readonly catalog: ModelsDevCatalog | null;
  readonly turns: ReadonlyArray<UsageTurn>;
}) => {
  const completed = input.turns.filter((data) => data.turn.status === "completed");
  const prices = completed.map((data) => priceUsageTurn({ catalog: input.catalog, data }));
  const costs = prices.flatMap(({ cost }) => (cost?.estimatedUsd != null ? [cost] : []));
  const sum = (
    field: "estimatedUsd" | "estimatedInputUsd" | "cacheReadUsd" | "cacheWriteUsd" | "outputUsd",
  ) =>
    costs.length > 0 && costs.every((cost) => cost[field] !== null)
      ? costs.reduce((total, cost) => total + (cost[field] ?? 0), 0)
      : null;
  return {
    totalUsd: sum("estimatedUsd"),
    inputUsd: sum("estimatedInputUsd"),
    cachedUsd: sum("cacheReadUsd"),
    cacheWriteUsd: sum("cacheWriteUsd"),
    outputUsd: sum("outputUsd"),
    pricedTurns: costs.length,
    completedTurns: completed.length,
    partial: costs.length !== completed.length,
    assumptions: Array.from(new Set(prices.flatMap(({ cost }) => cost?.assumptions ?? []))),
    canonicalFallback: prices.some(
      ({ price }) => price?.fallback !== null && price?.fallback !== undefined,
    ),
  };
};

export const pricingAssumption = (value: string) => {
  switch (value) {
    case "cache-read-tokens-unknown":
      return "Unreported cached tokens are priced as normal input.";
    case "cache-write-tokens-unknown":
      return "Cache writes are unreported; the estimate assumes none.";
    case "cache-read-rate-assumed-input":
      return "No cache-read rate is listed; the normal input rate is used.";
    case "cache-write-rate-assumed-input":
      return "No cache-write rate is listed; the normal input rate is used.";
    case "context-tokens-unknown":
      return "Context size is unavailable; standard context rates are used.";
    default:
      return "Some pricing details are unavailable.";
  }
};
