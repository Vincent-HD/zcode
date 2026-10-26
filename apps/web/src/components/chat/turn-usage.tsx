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
    value == null ? "—" : `${value.toLocaleString()} tok`;
  return (
    <UsagePopover
      label="Turn usage"
      icon={<Database className="size-3.5 shrink-0" />}
      summary={`Usage ${compactTokenCount(total)} tok${usage?.partial ? " · partial" : ""}`}
    >
      <dl>
        <UsageRow
          label="Provider / model"
          value={
            <span className="break-all">
              {props.data.providerLabel ?? "Unknown"} /{" "}
              {props.data.selection?.model ?? "Not recorded"}
            </span>
          }
        />
        <UsageRow label="Total tokens" value={tokens(total)} />
        <UsageRow label="Cache hit" value={cacheHit === null ? "—" : `${cacheHit.toFixed(1)}%`} />
        <UsageRow
          label="Non-cached input"
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
          label="Cached input"
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
          label="Output"
          value={
            <span>
              {tokens(usage?.outputTokens)}
              {priced.cost?.outputUsd != null ? ` · ${usageDollars(priced.cost.outputUsd)}` : ""}
            </span>
          }
        />
        {usage?.reasoningTokens != null && (
          <UsageRow label="Reasoning (output subset)" value={tokens(usage.reasoningTokens)} />
        )}
        <UsageRow
          label="Estimated API cost"
          value={
            priced.cost?.estimatedUsd != null
              ? usageDollars(priced.cost.estimatedUsd)
              : pricing.loading
                ? "Loading rates…"
                : "Unavailable"
          }
        />
        <UsageRow
          label="Turn time"
          value={formatUsageDuration(completedTurnDuration(props.data.turn))}
        />
        <UsageRow
          label="Average throughput"
          value={usage?.tokensPerSecond == null ? "—" : `${usage.tokensPerSecond.toFixed(1)} tok/s`}
        />
      </dl>
      <p className="mt-2 text-2xs text-muted-foreground">
        {usage
          ? "This provider turn only; excludes subagents. Throughput includes reasoning, tools and waits."
          : "This provider did not report token usage for this turn."}
      </p>
      <p className="mt-2 text-2xs text-muted-foreground">
        Current{" "}
        <a className="underline" href="https://models.dev" target="_blank" rel="noreferrer">
          models.dev
        </a>{" "}
        rates, not subscription charges.
        {priced.price
          ? ` ${priced.price.provider}/${priced.price.model} · ${priced.price.mode}.`
          : " No matching rate is available."}
        {priced.price?.fallback
          ? " Canonical model list price; your custom provider may charge differently."
          : ""}
      </p>
      {priced.cost?.assumptions.map((assumption) => (
        <p key={assumption} className="mt-1 text-2xs text-muted-foreground">
          {pricingAssumption(assumption)}
        </p>
      ))}
      {pricing.error && (
        <p className="mt-1 text-2xs text-muted-foreground">
          {pricing.error}
          {pricing.catalog ? " · Using the last fetched rates." : ""}
        </p>
      )}
    </UsagePopover>
  );
};
