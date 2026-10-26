import type { UsageLimitsReport } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { CircleGauge, Database, Gauge, Wallet } from "lucide-react";
import type * as DateTime from "effect/DateTime";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { useModelsDevPricing } from "./use-models-dev-pricing";
import { sessionPricing, usageDollars, pricingAssumption } from "./usage-pricing";
import { UsagePopover, UsageRow } from "./usage-popover";
import type { UsageTurn } from "./turn-usage.logic";
import { Button } from "../ui/button";
import {
  composerQuotaSummary,
  compactTokenCount,
  completedTurnDuration,
  formatUsageDuration,
  lastResponseUsage,
  sessionUsage,
  toolUsageDuration,
  type CompletedUsageTurn,
} from "./composer-usage.logic";

const count = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString());
const percent = (value: number | null) => (value === null ? "—" : `${value.toFixed(0)}%`);

export const ComposerUsageFooter = (props: {
  readonly accounts: UsageLimitsReport["accounts"];
  readonly context: ContextWindowSnapshot | null;
  readonly lastTurn: CompletedUsageTurn | null;
  readonly turns: ReadonlyArray<CompletedUsageTurn>;
  readonly usageTurns: ReadonlyArray<UsageTurn>;
  readonly toolCalls: ReadonlyArray<{
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
  }>;
  readonly onOpenLimits: () => void;
}) => {
  const pricing = useModelsDevPricing();
  const costs = sessionPricing({ catalog: pricing.catalog, turns: props.usageTurns });
  const usage = lastResponseUsage(props.lastTurn);
  const session = sessionUsage(props.turns);
  const toolTime = toolUsageDuration(props.toolCalls);
  const context = props.context;
  const speed =
    usage?.tokensPerSecond == null ? "— tok/s" : `${usage.tokensPerSecond.toFixed(1)} tok/s`;
  const accountSummary = composerQuotaSummary(props.accounts);
  return (
    <div
      data-composer-usage-footer="true"
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-border/40 px-3 py-1 text-2xs text-muted-foreground tabular-nums sm:px-4"
    >
      <UsagePopover
        label="Session statistics"
        icon={<Gauge className="size-3.5 shrink-0" />}
        summary={`${session.turns} turns · ${props.toolCalls.length} tools · ${speed}`}
      >
        <dl>
          <UsageRow label="Completed turns" value={session.turns} />
          <UsageRow label="Tool calls" value={props.toolCalls.length} />
          <UsageRow label="Turn time" value={formatUsageDuration(session.durationMs)} />
          <UsageRow label="Tool time" value={formatUsageDuration(toolTime)} />
          <UsageRow
            label="Last response time"
            value={formatUsageDuration(completedTurnDuration(props.lastTurn))}
          />
          <UsageRow label="Time to first token" value="Not reported" />
          <UsageRow label="Last response throughput" value={speed} />
        </dl>
        <p className="mt-2 text-2xs text-muted-foreground">
          Totals cover available completed turns in the active provider session.
        </p>
        <p className="mt-2 text-2xs text-muted-foreground">
          Throughput averages output over the full turn, including reasoning, tools and waits.
          Overlapping tool calls count once in tool time.
        </p>
      </UsagePopover>
      <UsagePopover
        label="Token usage"
        icon={<Database className="size-3.5 shrink-0" />}
        summary={
          <>
            {compactTokenCount(session.totalTokens)} tok · Cache hit{" "}
            {percent(session.cacheHitPercent)}
            {costs.totalUsd !== null
              ? ` · ${usageDollars(costs.totalUsd)}${costs.partial ? "+" : ""}`
              : ""}
          </>
        }
      >
        <dl>
          <UsageRow label="Session total" value={`${count(session.totalTokens)} tok`} />
          <UsageRow label="Cache hit" value={percent(session.cacheHitPercent)} />
          <UsageRow
            label="Non-cached input"
            value={
              <span>
                {count(session.uncachedInputTokens)} tok
                {!costs.partial && costs.inputUsd !== null
                  ? ` · ${usageDollars(costs.inputUsd + (costs.cacheWriteUsd ?? 0))}`
                  : ""}
              </span>
            }
          />
          <UsageRow
            label="Cached input"
            value={
              <span>
                {count(session.cachedInputTokens)} tok
                {!costs.partial && costs.cachedUsd !== null
                  ? ` · ${usageDollars(costs.cachedUsd)}`
                  : ""}
              </span>
            }
          />
          {session.cacheCreationTokens !== null && (
            <UsageRow
              label="Cache writes (input subset)"
              value={`${count(session.cacheCreationTokens)} tok`}
            />
          )}
          <UsageRow
            label="Output"
            value={
              <span>
                {count(session.outputTokens)} tok
                {!costs.partial && costs.outputUsd !== null
                  ? ` · ${usageDollars(costs.outputUsd)}`
                  : ""}
              </span>
            }
          />
          <UsageRow
            label="Estimated API cost"
            value={
              costs.totalUsd !== null
                ? `${usageDollars(costs.totalUsd)}${costs.partial ? "+" : ""}`
                : pricing.loading
                  ? "Loading rates…"
                  : "Unavailable"
            }
          />
          {context?.cost && (
            <UsageRow
              label="Provider-reported cost"
              value={`${context.cost.currency} ${context.cost.amount.toFixed(1)}`}
            />
          )}
        </dl>
        <div className="mt-2 border-t border-border/60 pt-2">
          <p className="mb-1 font-medium text-foreground">Last response</p>
          <dl>
            <UsageRow label="Input" value={`${count(usage?.inputTokens)} tok`} />
            <UsageRow label="Output" value={`${count(usage?.outputTokens)} tok`} />
            <UsageRow
              label="Reasoning (output subset)"
              value={`${count(usage?.reasoningTokens)} tok`}
            />
          </dl>
        </div>
        <p className="mt-2 text-2xs text-muted-foreground">
          Available completed main-agent turns in the active provider session; excludes subagents.
          {session.partial
            ? ` Partial totals: ${session.reportedTurns}/${session.turns} turns reported usage.`
            : ""}
        </p>
        <p className="mt-2 text-2xs text-muted-foreground">
          Current{" "}
          <a className="underline" href="https://models.dev" target="_blank" rel="noreferrer">
            models.dev
          </a>{" "}
          API-equivalent estimates; subscription charges are separate. {costs.pricedTurns}/
          {costs.completedTurns} turns priced.
          {costs.canonicalFallback
            ? " Some models use canonical list prices; custom provider charges may differ."
            : ""}
        </p>
        {costs.assumptions.map((assumption) => (
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
      <UsagePopover
        label="Context usage"
        icon={<CircleGauge className="size-3.5 shrink-0" />}
        summary={percent(context?.usedPercentage ?? null)}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span>
            <strong className="font-medium text-foreground">
              {percent(context?.usedPercentage ?? null)}
            </strong>{" "}
            of context used
          </span>
          <span className="text-foreground">
            {compactTokenCount(context?.usedTokens)} / {compactTokenCount(context?.maxTokens)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Context window used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={context?.usedPercentage ?? undefined}
          className="mb-3 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${context?.usedPercentage ?? 0}%` }}
          />
        </div>
        <dl>
          <UsageRow label="Used context" value={`${count(context?.usedTokens)} tok`} />
          <UsageRow label="Remaining" value={`${count(context?.remainingTokens)} tok`} />
          <UsageRow label="System prompt" value="Not reported" />
          <UsageRow label="Tool definitions" value="Not reported" />
          <UsageRow label="Messages" value="Not reported" />
        </dl>
        <p className="mt-2 text-2xs text-muted-foreground">
          {context
            ? `Provider report: ${context.updatedAt}. Component breakdown is unavailable.`
            : "Provider has not reported context usage."}
        </p>
      </UsagePopover>
      <UsagePopover
        label="Account usage"
        icon={<Wallet className="size-3.5 shrink-0" />}
        summary={accountSummary}
      >
        {props.accounts.length === 0 && <p>No account usage reported for this provider.</p>}
        {props.accounts.map((account) => (
          <div key={account.id} className="mb-2 last:mb-0">
            <p className="mb-1 font-medium text-foreground">
              {account.displayName ?? account.sourceLabel ?? account.driver}
            </p>
            <dl>
              {account.limits.windows.map((window) => (
                <UsageRow
                  key={window.label}
                  label={window.label}
                  value={`${percent(window.usedPercent)} used`}
                />
              ))}
            </dl>
            {account.limits.windows.map(
              (window) =>
                window.resetsAt && (
                  <p key={window.label} className="mt-1 text-2xs text-muted-foreground">
                    {window.label} resets {window.resetsAt}
                  </p>
                ),
            )}
            <p className="mt-1 text-2xs text-muted-foreground">
              Checked {account.limits.checkedAt}
              {limitsNotice(account.limits) ? ` · ${limitsNotice(account.limits)}` : ""}
            </p>
          </div>
        ))}
        <Button variant="outline" size="xs" onClick={props.onOpenLimits}>
          Open account limits
        </Button>
        <p className="mt-2 text-2xs text-muted-foreground">
          Account quota is separate from the API-equivalent token cost.
        </p>
      </UsagePopover>
    </div>
  );
};
