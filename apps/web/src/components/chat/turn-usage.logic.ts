import type {
  ModelSelection,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
  ProviderTurnId,
  RunId,
} from "@t3tools/contracts";

export interface UsageTurn {
  readonly turn: OrchestrationV2ProviderTurn;
  readonly selection: ModelSelection | null;
  readonly driver: string | null;
  readonly providerLabel: string | null;
}

type UsageProjection = {
  readonly providerTurns: OrchestrationV2ThreadProjection["providerTurns"];
  readonly nodes: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["nodes"][number], "id" | "runId">
  >;
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["runs"][number],
      "id" | "modelSelection" | "providerInstanceId"
    >
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["providerThreads"][number],
      "id" | "driver" | "providerInstanceId"
    >
  >;
};

export const resolveUsageTurn = (input: {
  readonly projection: UsageProjection;
  readonly providerTurnId: ProviderTurnId;
  readonly runId?: RunId | null;
}): UsageTurn | null => {
  const turn = input.projection.providerTurns.find(
    (candidate) => candidate.id === input.providerTurnId,
  );
  if (!turn) return null;
  const node = input.projection.nodes.find((candidate) => candidate.id === turn.nodeId);
  const runId = input.runId ?? node?.runId;
  const run = input.projection.runs.find((candidate) => candidate.id === runId);
  const providerThread = input.projection.providerThreads.find(
    (candidate) => candidate.id === turn.providerThreadId,
  );
  return {
    turn,
    selection: run?.modelSelection ?? null,
    driver: providerThread?.driver ?? null,
    providerLabel: providerThread?.providerInstanceId ?? run?.providerInstanceId ?? null,
  };
};
