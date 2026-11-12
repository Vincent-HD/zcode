import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type JjDiffResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { DropdownMenuRadioItem } from "../components/ui/menu";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { jjEnvironment } from "../state/jj";
import { formatEnvironmentQueryError } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { selectJjRevision } from "./jj-diff-selection";

interface JjDiffState {
  readonly scope: string;
  readonly pending: boolean;
  readonly data: JjDiffResult | null;
  readonly error: string | null;
}

const STALE_DIFF_ERROR =
  "The Jujutsu diff no longer matches the selected revision or operation. Refresh the Jujutsu panel and open the file again.";
const ERROR_SUFFIX =
  " Refresh the Jujutsu panel and open the file again if its operation has changed.";

/** The selected Jujutsu revision diff for DiffPanel, or null when the selection is not Jujutsu. */
export const useJjDiff = (input: {
  readonly routeThreadRef: ScopedThreadRef | null | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly activeCwd: string | null | undefined;
  readonly supportsJjDiff: boolean | undefined;
  readonly serverConfigLoaded: boolean;
}) => {
  const { routeThreadRef, activeCwd } = input;
  const getJjPanel = useAtomCommand(jjEnvironment.getPanel, {
    reportFailure: false,
    reportDefect: false,
  });
  const getJjDiff = useAtomCommand(jjEnvironment.getDiff, {
    reportFailure: false,
    reportDefect: false,
  });
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
  );
  const selection = diffSelection.kind === "jj" ? diffSelection : null;
  const canReadJj = useEnvironmentScope(input.environmentId, AuthFilesystemReadScope);
  const supportsJj = input.supportsJjDiff === true;
  const [refreshId, setRefreshId] = useState(0);
  const [diffState, setDiffState] = useState<JjDiffState | null>(null);
  const jjEnvironmentId = routeThreadRef?.environmentId;
  const jjThreadId = routeThreadRef?.threadId;
  const requestScope = JSON.stringify([
    jjEnvironmentId,
    jjThreadId,
    activeCwd,
    selection,
    refreshId,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected remote Jujutsu diff and drops stale replies
  useEffect(() => {
    if (!selection || !jjEnvironmentId || !jjThreadId || !activeCwd || !canReadJj || !supportsJj)
      return;
    const threadRef = { environmentId: jjEnvironmentId, threadId: jjThreadId };
    let cancelled = false;
    const load = async () => {
      setDiffState({ scope: requestScope, pending: true, data: null, error: null });
      // Older restored selections acquire one operation; retries never silently move it.
      if (!selection.context) {
        const result = await getJjPanel({
          environmentId: jjEnvironmentId,
          input: { cwd: activeCwd },
        });
        if (cancelled) return;
        if (result._tag === "Failure" || result.value.status !== "ready") {
          setDiffState({
            scope: requestScope,
            pending: false,
            data: null,
            error:
              result._tag === "Failure"
                ? formatEnvironmentQueryError(result.cause)
                : result.value.status === "unavailable" &&
                    result.value.reason === "missing-executable"
                  ? "Jujutsu is not installed in this environment."
                  : "This directory is not a Jujutsu workspace.",
          });
          return;
        }
        if (
          selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef) !==
          selection
        )
          return;
        selectJjRevision(threadRef, selection.revisionCommitId, selection.filePath ?? undefined, {
          workspaceIdentity: result.value.workspaceIdentity,
          expectedOperationId: result.value.operationId,
        });
        return;
      }
      const result = await getJjDiff({
        environmentId: jjEnvironmentId,
        input: {
          cwd: activeCwd,
          ...selection.context,
          revisionCommitId: selection.revisionCommitId,
          ...(selection.filePath ? { filePath: selection.filePath } : {}),
        },
      });
      if (cancelled) return;
      const matchesSelection =
        result._tag === "Success" &&
        result.value.commitId === selection.revisionCommitId &&
        result.value.operationId === selection.context.expectedOperationId;
      setDiffState({
        scope: requestScope,
        pending: false,
        data: matchesSelection ? result.value : null,
        error:
          result._tag === "Failure"
            ? formatEnvironmentQueryError(result.cause)
            : matchesSelection
              ? null
              : STALE_DIFF_ERROR,
      });
    };
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeCwd,
    canReadJj,
    getJjDiff,
    getJjPanel,
    requestScope,
    jjEnvironmentId,
    jjThreadId,
    selection,
    supportsJj,
  ]);
  if (!selection) return null;
  const current = diffState?.scope === requestScope ? diffState : null;
  const label = `JJ ${selection.revisionCommitId.slice(0, 12)}`;
  return {
    label,
    scopeValue: "jj",
    loadingLabel: "Loading Jujutsu diff...",
    filePath: selection.filePath,
    revealRequestId: selection.revealRequestId,
    sectionId: `jj:${JSON.stringify([activeCwd, selection.context, selection.revisionCommitId, selection.filePath])}`,
    patch: current?.data?.diff,
    truncated: current?.data?.truncated === true,
    isPending: !current || current.pending,
    data: current?.data ?? null,
    error: current?.error ? `${current.error}${ERROR_SUFFIX}` : null,
    canRefresh: canReadJj && supportsJj,
    refresh: () => setRefreshId((value) => value + 1),
    blockedMessage: !supportsJj
      ? input.serverConfigLoaded
        ? "This environment's T3 Code server does not support Jujutsu diffs. Update that server to use them."
        : "Waiting for the environment…"
      : !canReadJj
        ? "This connection needs filesystem read permission to view Jujutsu diffs."
        : null,
  };
};

export const JjDiffScopeItem = (props: { readonly label: string }) => (
  <DropdownMenuRadioItem value="jj" closeOnClick>
    <span>{props.label}</span>
  </DropdownMenuRadioItem>
);
