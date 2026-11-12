import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";

import { selectComposerUsageAccounts } from "../components/chat/composer-usage.logic";
import { ComposerUsageFooter } from "../components/chat/ComposerUsageFooter";
import { destroyTemporaryConversation } from "../components/chat/temporaryConversationDestroy";
import { resolveUsageTurn } from "../components/chat/turn-usage.logic";
import type { DraftId, DraftThreadState } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { useQuietThreadProjection } from "../state/entities";
import { useIsJjDiffSelected } from "./jj-diff-selection";
import { zcodeSurfaceLaunchers, type ZcodeRightPanelContext } from "./right-panel-surfaces";
import { useIsTemporaryThread } from "./temporary-conversation-store";
import type { ZcodeTemporaryConversation } from "./temporary-header";

export { isJjDiffSelection } from "./jj-diff-selection";

/** Everything ChatView hands to fork surfaces, derived once per render. */
export const useZcodeChatView = (input: {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly draftId: DraftId | null;
  readonly draftThread: DraftThreadState | null;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly projectId: ProjectId | null;
  readonly isServerThread: boolean;
}) => {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const { deleteThread } = useThreadActions();
  const isJjDiffSelected = useIsJjDiffSelected(input.activeThreadRef);
  const temporaryKeys = [
    input.routeThreadKey,
    ...(input.draftThread?.promotedTo ? [scopedThreadKey(input.draftThread.promotedTo)] : []),
  ];
  const isTemporaryConversation = useIsTemporaryThread(temporaryKeys);
  const rightPanel: ZcodeRightPanelContext = {
    threadRef: input.activeThreadRef,
    cwd: input.gitCwd,
    projectId: input.projectId,
    isServerThread: input.isServerThread,
  };
  const temporary: ZcodeTemporaryConversation = {
    keys: temporaryKeys,
    destroy: () =>
      destroyTemporaryConversation({
        environmentId: input.environmentId,
        routeKind: input.routeKind,
        draftId: input.draftId,
        draftThread: input.draftThread,
        routeThreadRef: input.routeThreadRef,
        routeThreadKey: input.routeThreadKey,
        temporaryThreadKeys: temporaryKeys,
        deleteThread,
        startNewThread: handleNewThread,
        navigateAway: () => navigate({ to: "/", replace: true }),
      }),
  };
  return {
    isJjDiffSelected,
    isTemporaryConversation,
    launchers: zcodeSurfaceLaunchers(rightPanel),
    rightPanel,
    temporary,
  };
};

type UsageProjection = NonNullable<ReturnType<typeof useQuietThreadProjection>>["projection"];

export const ZcodeComposerUsageFooter = (props: {
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly activeProviderStatus: ServerProvider | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly usageLimitSources: UsageLimitSourceSnapshots;
  readonly projection: UsageProjection | null;
  readonly context: ContextWindowSnapshot | null;
  readonly onOpenLimits: () => void;
}) => {
  const projection = props.projection;
  const accounts =
    props.activeProviderInstanceId === null || props.activeProviderStatus === null
      ? []
      : selectComposerUsageAccounts(
          collectProviderUsageLimits(
            props.activeProviderInstanceId,
            props.providerStatuses,
            props.usageLimitSources,
            Date.parse(props.activeProviderStatus.checkedAt),
          )?.accounts ?? [],
          props.activeProviderInstanceId,
        );
  const turns =
    projection?.providerTurns.filter(
      (turn) => turn.providerThreadId === projection.thread.activeProviderThreadId,
    ) ?? [];
  const completedTurnIds = new Set(
    turns.filter((turn) => turn.status === "completed").map((turn) => turn.id),
  );
  const toolCalls =
    projection?.nodes.filter(
      (node) =>
        node.kind === "tool_call" &&
        node.providerTurnId !== null &&
        completedTurnIds.has(node.providerTurnId),
    ) ?? [];
  const usageTurns = projection
    ? turns.flatMap((turn) => {
        const data = resolveUsageTurn({ projection, providerTurnId: turn.id });
        return data ? [data] : [];
      })
    : [];
  return (
    <ComposerUsageFooter
      accounts={accounts}
      context={props.context}
      toolCalls={toolCalls}
      turns={turns}
      usageTurns={usageTurns}
      lastTurn={
        projection?.providerTurns.findLast(
          (turn) =>
            turn.status === "completed" &&
            turn.providerThreadId === projection.thread.activeProviderThreadId,
        ) ?? null
      }
      onOpenLimits={props.onOpenLimits}
    />
  );
};
