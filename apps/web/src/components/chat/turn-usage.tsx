import { T, useGT, useMessages } from "gt-react";
import { useModelsDevPricing } from "./use-models-dev-pricing";
import { priceUsageTurn, usageDollars, pricingAssumption } from "./usage-pricing";
import { Database } from "lucide-react";
import {
  compactTokenCount,
  completedTurnDuration,
  formatUsageDuration,
  lastResponseUsage,
} from "./composer-usage.logic";
import type { UsageTurn } from "./turn-usage.logic";
import { UsagePopover, UsageRow } from "./usage-popover";

export const TurnUsage = (props: { readonly data: UsageTurn }) => {
  const gt = useGT();
  const messages = useMessages();
  const pricing = useModelsDevPricing();
  const priced = priceUsageTurn({ catalog: pricing.catalog, data: props.data });
  const usage = lastResponseUsage(props.data.turn);
  if (props.data.turn.status !== "completed") return null;
  const total =
    usage?.inputTokens !== null && usage?.inputTokens !== undefined && usage.outputTokens !== null
      ? usage.inputTokens + usage.outputTokens
      : null;
  const cached = usage?.cachedInputTokens;
  const input = usage?.inputTokens;
  const cacheHit =
    input != null && input > 0 && cached != null && cached <= input ? (cached / input) * 100 : null;
  const uncached = input != null && cached != null && input >= cached ? input - cached : null;
  const tokens = (value: number | null | undefined) =>
    value == null ? "N/A tok" : `${value.toLocaleString()} tok`;
  const totalTokens = compactTokenCount(total);
  return (
    <UsagePopover
      label={gt("Turn usage")}
      icon={<Database className="size-3.5 shrink-0" />}
      summary={
        usage?.partial
          ? gt("Usage {tokens} tok · partial", { tokens: totalTokens })
          : gt("Usage {tokens} tok", { tokens: totalTokens })
      }
    >
      <dl>
        <UsageRow
          label={gt("Provider / model")}
          value={
            <span className="break-all">
              {props.data.providerLabel ?? gt("Unknown", { $context: "provider name" })} /{" "}
              {props.data.selection?.model ?? gt("Not recorded")}
            </span>
          }
        />
        <UsageRow label={gt("Total tokens")} value={tokens(total)} />
        <UsageRow
          label={gt("Cache hit")}
          value={cacheHit === null ? "N/A" : `${cacheHit.toFixed(1)}%`}
        />
        <UsageRow
          label={gt("Non-cached input")}
          value={
            <span>
              {tokens(uncached)}
              {priced.cost?.estimatedInputUsd != null
                ? ` · ${usageDollars(priced.cost.estimatedInputUsd + (priced.cost.cacheWriteUsd ?? 0))}`
                : ""}
            </span>
          }
        />
        <UsageRow
          label={gt("Cached input")}
          value={
            <span>
              {tokens(cached)}
              {priced.cost?.cacheReadUsd != null
                ? ` · ${usageDollars(priced.cost.cacheReadUsd)}`
                : ""}
            </span>
          }
        />
        <UsageRow
          label={gt("Output", { $context: "output tokens" })}
          value={
            <span>
              {tokens(usage?.outputTokens)}
              {priced.cost?.outputUsd != null ? ` · ${usageDollars(priced.cost.outputUsd)}` : ""}
            </span>
          }
        />
        {usage?.reasoningTokens != null && (
          <UsageRow label={gt("Reasoning (output subset)")} value={tokens(usage.reasoningTokens)} />
        )}
        <UsageRow
          label={gt("Estimated API cost")}
          value={
            priced.cost?.estimatedUsd != null
              ? usageDollars(priced.cost.estimatedUsd)
              : pricing.loading
                ? gt("Loading rates…")
                : gt("Unavailable", { $context: "estimated cost is unavailable" })
          }
        />
        <UsageRow
          label={gt("Turn time")}
          value={formatUsageDuration(completedTurnDuration(props.data.turn))}
        />
        <UsageRow
          label={gt("Average throughput")}
          value={
            usage?.tokensPerSecond == null
              ? "N/A tok/s"
              : `${usage.tokensPerSecond.toFixed(1)} tok/s`
          }
        />
      </dl>
      <p className="mt-2 text-2xs text-muted-foreground">
        {usage
          ? gt(
              "This provider turn only; excludes subagents. Throughput includes reasoning, tools and waits.",
            )
          : gt("This provider did not report token usage for this turn.")}
      </p>
      <p className="mt-2 text-2xs text-muted-foreground">
        <T>
          Current{" "}
          <a className="underline" href="https://models.dev" target="_blank" rel="noreferrer">
            models.dev
          </a>{" "}
          rates, not subscription charges.
        </T>
        {priced.price
          ? ` ${priced.price.provider}/${priced.price.model} · ${priced.price.mode}.`
          : ` ${gt("No matching rate is available.")}`}
        {priced.price?.fallback
          ? ` ${gt("Canonical model list price; your custom provider may charge differently.")}`
          : ""}
      </p>
      {priced.cost?.assumptions.map((assumption) => (
        <p key={assumption} className="mt-1 text-2xs text-muted-foreground">
          {pricingAssumption(assumption, messages)}
        </p>
      ))}
      {pricing.error && (
        <p className="mt-1 text-2xs text-muted-foreground">
          {pricing.error}
          {pricing.catalog ? ` · ${gt("Using the last fetched rates.")}` : ""}
        </p>
      )}
    </UsagePopover>
  );
};
