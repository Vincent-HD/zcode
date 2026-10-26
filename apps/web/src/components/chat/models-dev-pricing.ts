import type { TurnTokenUsage } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const Rate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Rates = Schema.Struct({
  input: Schema.optionalKey(Rate),
  output: Schema.optionalKey(Rate),
  cache_read: Schema.optionalKey(Rate),
  cache_write: Schema.optionalKey(Rate),
});
const Cost = Schema.Struct({
  ...Rates.fields,
  tiers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...Rates.fields,
        tier: Schema.Struct({
          type: Schema.String,
          size: Rate,
        }),
      }),
    ),
  ),
});
const Model = Schema.Struct({
  id: Schema.String,
  canonical_model_id: Schema.optionalKey(Schema.String),
  cost: Schema.optionalKey(Cost),
  experimental: Schema.optionalKey(
    Schema.Struct({
      modes: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Struct({ cost: Schema.optionalKey(Cost) })),
      ),
    }),
  ),
});
const Catalog = Schema.Record(
  Schema.String,
  Schema.Struct({ models: Schema.Record(Schema.String, Model) }),
);
const decodeCatalog = Schema.decodeUnknownResult(Catalog);

export type ModelsDevCatalog = typeof Catalog.Type;
export type ModelsDevPrice = {
  readonly provider: string;
  readonly model: string;
  readonly fallback: "canonical-list-price" | null;
  readonly mode: "standard" | "fast" | "ultrafast";
  readonly contextThreshold: number | null;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly assumptions: ReadonlyArray<string>;
};
export type ModelsDevCost = {
  readonly estimatedUsd: number | null;
  readonly estimatedInputUsd: number | null;
  readonly inputUsd: number | null;
  readonly outputUsd: number | null;
  readonly cacheReadUsd: number | null;
  readonly cacheWriteUsd: number | null;
  readonly totalUsd: number | null;
  readonly partial: boolean;
  readonly assumptions: ReadonlyArray<string>;
};

/** Invalid documents stay unpriced; absent rates are never converted to zero. */
export const parseModelsDevPricing = (document: unknown): ModelsDevCatalog | null => {
  const result = decodeCatalog(document);
  return Result.isSuccess(result) ? result.success : null;
};

const providerAlias = (driver: string | null) => {
  if (driver === "codex") return "openai";
  if (driver === "claudeAgent") return "anthropic";
  return driver;
};
const findModel = ({
  catalog,
  provider,
  model,
}: {
  catalog: ModelsDevCatalog;
  provider: string;
  model: string;
}) => {
  const models = Object.hasOwn(catalog, provider) ? catalog[provider]?.models : undefined;
  if (!models) return null;
  if (Object.hasOwn(models, model)) return models[model] ?? null;
  const matches = Object.values(models).filter((entry) => entry.id === model);
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

export const resolveModelsDevPrice = ({
  catalog,
  model,
  driver,
  options,
  contextTokens,
}: {
  catalog: ModelsDevCatalog | null;
  model: string;
  driver: string | null;
  options?: Readonly<Record<string, unknown>>;
  contextTokens?: number | null;
}): ModelsDevPrice | null => {
  if (!catalog || !model) return null;
  let provider = providerAlias(driver);
  let entry = provider ? findModel({ catalog, provider, model }) : null;
  let fallback: ModelsDevPrice["fallback"] = null;
  const slash = model.indexOf("/");
  const prefix = slash > 0 ? model.slice(0, slash) : null;
  const suffix = slash > 0 ? model.slice(slash + 1) : model;

  // An exact driver/model (including slashes in model IDs) wins over prefix parsing.
  if (!entry && prefix && Object.hasOwn(catalog, prefix)) {
    provider = prefix;
    entry = findModel({ catalog, provider, model: suffix });
    if (!entry) return null;
  }
  if (!entry) {
    if (!prefix || Object.hasOwn(catalog, prefix)) return null;
    const candidates = Object.entries(catalog).flatMap(([candidateProvider, value]) =>
      Object.entries(value.models)
        .filter(
          ([key, candidate]) =>
            key === suffix ||
            candidate.id === suffix ||
            candidate.canonical_model_id === suffix ||
            candidate.canonical_model_id === model ||
            candidate.canonical_model_id?.endsWith(`/${suffix}`),
        )
        .map(([key, candidate]) => ({
          provider: candidateProvider,
          canonical: candidate.canonical_model_id ?? `${candidateProvider}/${key}`,
        })),
    );
    const canonicalIds = new Set(candidates.map((candidate) => candidate.canonical));
    if (canonicalIds.size !== 1) return null;
    const canonical = candidates[0]?.canonical;
    if (!canonical) return null;
    const separator = canonical.indexOf("/");
    if (separator < 1) return null;
    provider = canonical.slice(0, separator);
    entry = findModel({ catalog, provider, model: canonical.slice(separator + 1) });
    if (!entry) return null;
    fallback = "canonical-list-price";
  }
  if (!provider) return null;

  const serviceTier = options?.serviceTier;
  let mode: ModelsDevPrice["mode"] = "standard";
  if (serviceTier === "ultrafast") mode = "ultrafast";
  else if (serviceTier === "priority" || serviceTier === "fast") mode = "fast";
  else if (
    serviceTier !== undefined &&
    serviceTier !== null &&
    serviceTier !== "default" &&
    serviceTier !== "auto" &&
    serviceTier !== "standard"
  )
    return null;
  else if (options?.fastMode === true) mode = "fast";
  const cost = mode === "standard" ? entry.cost : entry.experimental?.modes?.[mode]?.cost;
  if (!cost) return null;
  const assumptions: string[] = [];
  const tiers = cost.tiers ?? [];
  if (tiers.some((tier) => tier.tier.type !== "context")) return null;
  if (contextTokens !== undefined && contextTokens !== null && !validTokens(contextTokens))
    return null;
  const standardTiers = entry.cost?.tiers ?? [];
  if (
    (tiers.length > 0 || (mode !== "standard" && standardTiers.length > 0)) &&
    contextTokens == null
  )
    assumptions.push("context-tokens-unknown");
  // Standard context surcharges do not establish unpublished fast-mode rates.
  if (
    mode !== "standard" &&
    contextTokens != null &&
    standardTiers.some(
      (tier) =>
        contextTokens > tier.tier.size &&
        !tiers.some(
          (modeTier) =>
            modeTier.tier.type === tier.tier.type && modeTier.tier.size === tier.tier.size,
        ),
    )
  )
    return null;
  const contextTier =
    contextTokens == null
      ? undefined
      : tiers
          .filter((tier) => contextTokens > tier.tier.size)
          .sort((left, right) => right.tier.size - left.tier.size)[0];
  const rates = contextTier ?? cost;
  if (rates.input === undefined || rates.output === undefined) return null;
  return {
    provider,
    model: entry.id,
    fallback,
    mode,
    contextThreshold: contextTier?.tier.size ?? null,
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cache_read ?? null,
    cacheWrite: rates.cache_write ?? null,
    assumptions,
  };
};

const validTokens = (value: number) => Number.isSafeInteger(value) && value >= 0;

export const estimateModelsDevCost = ({
  price,
  usage,
}: {
  price: ModelsDevPrice | null;
  usage: TurnTokenUsage | undefined;
}): ModelsDevCost | null => {
  if (!price || !usage || usage.usageStatus === "unavailable") return null;
  if (
    [price.input, price.output, price.cacheRead, price.cacheWrite].some(
      (rate) => rate !== null && (!Number.isFinite(rate) || rate < 0),
    )
  )
    return null;
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
    usage.reasoningTokens,
  ];
  if (counts.some((count) => count !== undefined && !validTokens(count))) return null;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
  if (
    usage.reasoningTokens !== undefined &&
    usage.outputTokens !== undefined &&
    usage.reasoningTokens > usage.outputTokens
  )
    return null;
  const assumptions = [...price.assumptions];
  const read = usage.cachedInputTokens ?? 0;
  const write = usage.cacheCreationTokens ?? 0;
  if (usage.inputTokens !== undefined && read + write > usage.inputTokens) return null;
  if (usage.inputTokens !== undefined) {
    if (usage.cachedInputTokens === undefined) assumptions.push("cache-read-tokens-unknown");
    if (usage.cacheCreationTokens === undefined) assumptions.push("cache-write-tokens-unknown");
  }
  if (read > 0 && price.cacheRead === null) assumptions.push("cache-read-rate-assumed-input");
  if (write > 0 && price.cacheWrite === null) assumptions.push("cache-write-rate-assumed-input");
  const inputUsd =
    usage.inputTokens === undefined ||
    usage.cachedInputTokens === undefined ||
    usage.cacheCreationTokens === undefined
      ? null
      : ((usage.inputTokens - read - write) * price.input) / 1_000_000;
  const outputUsd =
    usage.outputTokens === undefined ? null : (usage.outputTokens * price.output) / 1_000_000;
  const cacheReadUsd =
    usage.cachedInputTokens === undefined
      ? null
      : (read * (price.cacheRead ?? price.input)) / 1_000_000;
  const cacheWriteUsd =
    usage.cacheCreationTokens === undefined
      ? null
      : (write * (price.cacheWrite ?? price.input)) / 1_000_000;
  const parts = [inputUsd, outputUsd, cacheReadUsd, cacheWriteUsd];
  if (parts.some((part) => part !== null && !Number.isFinite(part))) return null;
  const partial =
    usage.usageStatus !== "complete" ||
    assumptions.length > 0 ||
    parts.some((part) => part === null);
  const totalUsd = partial ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  if (totalUsd !== null && !Number.isFinite(totalUsd)) return null;
  const estimatedInputUsd =
    usage.inputTokens === undefined
      ? null
      : ((usage.inputTokens - read - write) * price.input) / 1_000_000;
  const estimatedUsd =
    usage.usageStatus === "complete" && estimatedInputUsd !== null && outputUsd !== null
      ? estimatedInputUsd +
        outputUsd +
        (read * (price.cacheRead ?? price.input)) / 1_000_000 +
        (write * (price.cacheWrite ?? price.input)) / 1_000_000
      : null;
  if (estimatedUsd !== null && !Number.isFinite(estimatedUsd)) return null;
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd,
    estimatedUsd,
    estimatedInputUsd,
    partial,
    assumptions,
  };
};
