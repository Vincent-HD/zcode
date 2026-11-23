import type { UsageLimitsReport } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { T, useGT, useMessages, Var } from "gt-react";
import { CircleGauge, Database, Gauge, Wallet } from "lucide-react";
import type * as DateTime from "effect/DateTime";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
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

const count = (value: number | null | undefined) =>
  value == null ? "N/A" : value.toLocaleString();
const percent = (value: number | null) => (value === null ? "N/A" : `${value.toFixed(0)}%`);

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
  const gt = useGT();
  const messages = useMessages();
  const pricing = useModelsDevPricing();
  const costs = sessionPricing({ catalog: pricing.catalog, turns: props.usageTurns });
  const usage = lastResponseUsage(props.lastTurn);
  const session = sessionUsage(props.turns);
  const toolTime = toolUsageDuration(props.toolCalls);
  const context = props.context;
  const speed =
    usage?.tokensPerSecond == null ? "N/A tok/s" : `${usage.tokensPerSecond.toFixed(1)} tok/s`;
  const accountSummary = composerQuotaSummary(props.accounts, messages);
  const notReported = gt("Not reported");
  return (
    <div
      data-composer-usage-footer="true"
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-border/40 px-3 py-1 text-2xs text-muted-foreground tabular-nums sm:px-4"
    >
      <UsagePopover
        label={gt("Session statistics")}
        icon={<Gauge className="size-3.5 shrink-0" />}
        summary={gt("{turns} turns · {tools} tools · {speed}", {
          turns: session.turns,
          tools: props.toolCalls.length,
          speed,
        })}
      >
        <dl>
          <UsageRow label={gt("Completed turns")} value={session.turns} />
          <UsageRow label={gt("Tool calls")} value={props.toolCalls.length} />
          <UsageRow label={gt("Turn time")} value={formatUsageDuration(session.durationMs)} />
          <UsageRow label={gt("Tool time")} value={formatUsageDuration(toolTime)} />
          <UsageRow
            label={gt("Last response time")}
            value={formatUsageDuration(completedTurnDuration(props.lastTurn))}
          />
          <UsageRow label={gt("Time to first token")} value={notReported} />
          <UsageRow label={gt("Last response throughput")} value={speed} />
        </dl>
        <p className="mt-2 text-2xs text-muted-foreground">
          <T>Totals cover available completed turns in the active provider session.</T>
        </p>
        <p className="mt-2 text-2xs text-muted-foreground">
          <T>
            Throughput averages output over the full turn, including reasoning, tools and waits.
            Overlapping tool calls count once in tool time.
          </T>
        </p>
      </UsagePopover>
      <UsagePopover
        label={gt("Token usage")}
        icon={<Database className="size-3.5 shrink-0" />}
        summary={
          <>
            {gt("{tokens} tok · Cache {percent}", {
              tokens: compactTokenCount(session.totalTokens),
              percent: percent(session.cacheHitPercent),
            })}
            {costs.totalUsd !== null
              ? ` · ${usageDollars(costs.totalUsd)}${costs.partial ? "+" : ""}`
              : ""}
          </>
        }
      >
        <dl>
          <UsageRow label={gt("Session total")} value={`${count(session.totalTokens)} tok`} />
          <UsageRow label={gt("Cache hit")} value={percent(session.cacheHitPercent)} />
          <UsageRow
            label={gt("Non-cached input")}
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
            label={gt("Cached input")}
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
              label={gt("Cache writes (input subset)")}
              value={`${count(session.cacheCreationTokens)} tok`}
            />
          )}
          <UsageRow
            label={gt("Output", { $context: "output tokens" })}
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
            label={gt("Estimated API cost")}
            value={
              costs.totalUsd !== null
                ? `${usageDollars(costs.totalUsd)}${costs.partial ? "+" : ""}`
                : pricing.loading
                  ? gt("Loading rates…")
                  : gt("Unavailable", { $context: "estimated cost is unavailable" })
            }
          />
          {context?.cost && (
            <UsageRow
              label={gt("Provider-reported cost")}
              value={`${context.cost.currency} ${context.cost.amount.toFixed(1)}`}
            />
          )}
        </dl>
        <div className="mt-2 border-t border-border/60 pt-2">
          <p className="mb-1 font-medium text-foreground">
            <T>Last response</T>
          </p>
          <dl>
            <UsageRow
              label={gt("Input", { $context: "input tokens" })}
              value={`${count(usage?.inputTokens)} tok`}
            />
            <UsageRow
              label={gt("Output", { $context: "output tokens" })}
              value={`${count(usage?.outputTokens)} tok`}
            />
            <UsageRow
              label={gt("Reasoning (output subset)")}
              value={`${count(usage?.reasoningTokens)} tok`}
            />
          </dl>
        </div>
        <p className="mt-2 text-2xs text-muted-foreground">
          <T>
            Available completed main-agent turns in the active provider session; excludes subagents.
          </T>
          {session.partial
            ? ` ${gt("Partial totals: {reported}/{turns} turns reported usage.", {
                reported: session.reportedTurns,
                turns: session.turns,
              })}`
            : ""}
        </p>
        <p className="mt-2 text-2xs text-muted-foreground">
          <T>
            Current{" "}
            <a className="underline" href="https://models.dev" target="_blank" rel="noreferrer">
              models.dev
            </a>{" "}
            API-equivalent estimates; subscription charges are separate.{" "}
            <Var>{costs.pricedTurns}</Var>/<Var>{costs.completedTurns}</Var> turns priced.
          </T>
          {costs.canonicalFallback
            ? ` ${gt("Some models use canonical list prices; custom provider charges may differ.")}`
            : ""}
        </p>
        {costs.assumptions.map((assumption) => (
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
      <UsagePopover
        label={gt("Context usage")}
        icon={<CircleGauge className="size-3.5 shrink-0" />}
        summary={percent(context?.usedPercentage ?? null)}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span>
            <T>
              <strong className="font-medium text-foreground">
                <Var>{percent(context?.usedPercentage ?? null)}</Var>
              </strong>{" "}
              of context used
            </T>
          </span>
          <span className="text-foreground">
            {compactTokenCount(context?.usedTokens)} / {compactTokenCount(context?.maxTokens)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={gt("Context window used")}
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
          <UsageRow label={gt("Used context")} value={`${count(context?.usedTokens)} tok`} />
          <UsageRow
            label={gt("Remaining", { $context: "remaining context tokens" })}
            value={`${count(context?.remainingTokens)} tok`}
          />
          <UsageRow label={gt("System prompt")} value={notReported} />
          <UsageRow label={gt("Tool definitions")} value={notReported} />
          <UsageRow
            label={gt("Messages", { $context: "context taken by conversation messages" })}
            value={notReported}
          />
        </dl>
        <p className="mt-2 text-2xs text-muted-foreground">
          {context
            ? gt("Provider report: {updatedAt}. Component breakdown is unavailable.", {
                updatedAt: context.updatedAt,
              })
            : gt("Provider has not reported context usage.")}
        </p>
      </UsagePopover>
      <UsagePopover
        label={gt("Account usage")}
        icon={<Wallet className="size-3.5 shrink-0" />}
        summary={accountSummary}
      >
        {props.accounts.length === 0 && (
          <p>
            <T>No account usage reported for this provider.</T>
          </p>
        )}
        {props.accounts.map((account) => {
          const notice = limitsNotice(account.limits, messages);
          return (
            <div key={account.id} className="mb-2 last:mb-0">
              <p className="mb-1 font-medium text-foreground">
                {account.displayName ?? account.sourceLabel ?? account.driver}
              </p>
              <dl>
                {account.limits.windows.map((window) => (
                  <UsageRow
                    key={window.id}
                    label={window.label}
                    value={gt("{percent}% left", { percent: remainingPercent(window) })}
                  />
                ))}
              </dl>
              {account.limits.windows.map(
                (window) =>
                  window.resetsAt && (
                    <p key={window.id} className="mt-1 text-2xs text-muted-foreground">
                      {gt("{label} resets {resetsAt}", {
                        label: window.label,
                        resetsAt: window.resetsAt,
                      })}
                    </p>
                  ),
              )}
              <p className="mt-1 text-2xs text-muted-foreground">
                {gt("Checked {checkedAt}", { checkedAt: account.limits.checkedAt })}
                {notice ? ` · ${notice}` : ""}
              </p>
            </div>
          );
        })}
        <Button variant="outline" size="xs" onClick={props.onOpenLimits}>
          <T>Open account limits</T>
        </Button>
        <p className="mt-2 text-2xs text-muted-foreground">
          <T>Account quota is separate from the API-equivalent token cost.</T>
        </p>
      </UsagePopover>
    </div>
  );
};
