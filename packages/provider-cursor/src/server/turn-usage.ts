import type { RunResult } from "@cursor/sdk";
import { TurnTokenUsage, type OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CursorTokenUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadTokens: TokenCount,
  cacheWriteTokens: TokenCount,
  reasoningTokens: Schema.optional(TokenCount),
});
const isCursorTokenUsage = Schema.is(CursorTokenUsage);
const isTurnTokenUsage = Schema.is(TurnTokenUsage);

export const cursorTurnTokenUsage = (input: {
  readonly usage: RunResult["usage"];
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly hasSubagents: boolean;
  readonly hasMissingUsage: boolean;
}): TurnTokenUsage => {
  const unavailable: TurnTokenUsage = {
    usageScope: "main_agent",
    usageStatus: "unavailable",
    hasSubagents: input.hasSubagents,
  };
  if (!isCursorTokenUsage(input.usage)) return unavailable;
  const usage = input.usage;
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens) {
    return unavailable;
  }

  // Cursor reports cache separately; T3 input includes it. Reasoning is already in output.
  const normalized = {
    usageScope: "main_agent",
    usageStatus: input.status === "completed" && !input.hasMissingUsage ? "complete" : "partial",
    inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheWriteTokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    hasSubagents: input.hasSubagents,
  };
  return isTurnTokenUsage(normalized) ? normalized : unavailable;
};

interface CursorTurnUsageState {
  missingUsage: boolean;
  usage: RunResult["usage"];
}

// Keyed by the adapter's active turn, so the adapter itself carries no fork state.
const usageByTurn = new WeakMap<object, CursorTurnUsageState>();

const usageState = (turn: object): CursorTurnUsageState => {
  const existing = usageByTurn.get(turn);
  if (existing) return existing;
  const created: CursorTurnUsageState = { missingUsage: false, usage: undefined };
  usageByTurn.set(turn, created);
  return created;
};

/** Remembers a turn-ended update that arrived without usage. */
export const recordCursorTurnUpdate = (
  turn: object,
  update: { readonly type: string; readonly usage?: unknown },
) => {
  if (update.type !== "turn-ended") return;
  const state = usageState(turn);
  state.missingUsage ||= update.usage === undefined;
};

export const recordCursorRunUsage = (turn: object, usage: RunResult["usage"]) => {
  usageState(turn).usage = usage;
};

/** Usage fields for a provider turn payload; only completed turns report usage. */
export const cursorTurnUsageFields = (input: {
  readonly context: { readonly subagents: { readonly size: number } };
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly completedAt: unknown;
}): { readonly turnTokenUsage?: TurnTokenUsage } => {
  if (input.completedAt === null) return {};
  const state = usageByTurn.get(input.context);
  return {
    turnTokenUsage: cursorTurnTokenUsage({
      usage: state?.usage,
      status: input.status,
      hasSubagents: input.context.subagents.size > 0,
      hasMissingUsage: state?.missingUsage ?? false,
    }),
  };
};
