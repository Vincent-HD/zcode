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
