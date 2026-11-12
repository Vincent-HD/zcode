import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { JjWorkspaceIdentity, ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";

export interface JjDiffContext {
  readonly workspaceIdentity: JjWorkspaceIdentity;
  readonly expectedOperationId: string;
}

export type JjDiffPanelSelection = {
  kind: "jj";
  revisionCommitId: string;
  /** Compares from this revision instead of from the revision's parents. */
  fromCommitId?: string;
  filePath: string | null;
  revealRequestId: number;
  context?: JjDiffContext;
};

export const selectJjRevision = (
  ref: ScopedThreadRef,
  revisionCommitId: string,
  filePath?: string,
  context?: JjDiffContext,
  fromCommitId?: string,
) =>
  useDiffPanelStore.setState((state) => {
    const threadKey = scopedThreadKey(ref);
    const previous = state.byThreadKey[threadKey];
    return {
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: {
          kind: "jj",
          revisionCommitId,
          ...(fromCommitId ? { fromCommitId } : {}),
          filePath: filePath?.trim() || null,
          revealRequestId: previous?.kind === "jj" ? previous.revealRequestId + 1 : 1,
          ...(context ? { context } : {}),
        },
      },
    };
  });

export const isJjDiffSelection = (ref: ScopedThreadRef | null | undefined) =>
  selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref).kind === "jj";

export const useIsJjDiffSelected = (ref: ScopedThreadRef | null | undefined) =>
  useDiffPanelStore(
    (state) => selectThreadDiffPanelSelection(state.byThreadKey, ref).kind === "jj",
  );

/** Reopens a selected Jujutsu diff where the Git diff launcher is unavailable. */
export const openSelectedJjDiff = (ref: ScopedThreadRef | null, isServerThread: boolean) => {
  if (!ref || !isServerThread || !isJjDiffSelection(ref)) return false;
  useRightPanelStore.getState().open(ref, "diff");
  return true;
};
