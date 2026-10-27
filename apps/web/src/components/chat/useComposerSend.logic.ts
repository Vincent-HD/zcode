import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import {
  clearBackgroundDraftSubmissionByRef,
  restoreFailedDraftThread,
  useComposerDraftStore,
  type DraftSessionState,
  type DraftId,
} from "../../composerDraftStore";
import { newThreadId } from "~/lib/utils";
import { useUiStateStore } from "../../uiStateStore";

/** Resolves temporary markers across a draft's current and promoted thread identities. */
export function isTemporaryComposerConversation(input: {
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
}): boolean {
  const currentDraftSession =
    input.draftId === null ? null : useComposerDraftStore.getState().getDraftSession(input.draftId);
  const threadKeys = new Set([
    input.routeThreadKey,
    ...(input.draftThread
      ? [
          scopedThreadKey(
            scopeThreadRef(input.draftThread.environmentId, input.draftThread.threadId),
          ),
          ...(input.draftThread.promotedTo ? [scopedThreadKey(input.draftThread.promotedTo)] : []),
        ]
      : []),
    ...(currentDraftSession
      ? [
          scopedThreadKey(
            scopeThreadRef(currentDraftSession.environmentId, currentDraftSession.threadId),
          ),
          ...(currentDraftSession.promotedTo
            ? [scopedThreadKey(currentDraftSession.promotedTo)]
            : []),
        ]
      : []),
  ]);
  const temporaryThreadKeys = useUiStateStore.getState().temporaryThreadKeys;
  return [...threadKeys].some((key) => temporaryThreadKeys.includes(key));
}

/** Runs a send only when a temporary conversation allows its submission intent. */
export function runTemporaryConversationSendGuard<T>(
  input: {
    readonly submissionIntent: ComposerSubmissionIntent;
    readonly isTemporaryConversation: boolean;
    readonly onBlocked: () => void;
  },
  continueSend: () => T,
): T | undefined {
  if (input.submissionIntent === "background" && input.isTemporaryConversation) {
    input.onBlocked();
    return undefined;
  }
  return continueSend();
}

/** Restores a failed draft and carries its temporary marker onto the retry thread id. */
export function restoreFailedDraftSend(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly draftId: DraftId;
  readonly draftThread: DraftSessionState;
  readonly threadIdForSend: ThreadId;
  readonly bootstrapThreadDeleted: boolean;
}): ThreadId {
  const currentDraftSession = useComposerDraftStore.getState().getDraftSession(input.draftId);
  const temporaryMarkerSourceKeys = new Set([
    input.routeThreadKey,
    scopedThreadKey(scopeThreadRef(input.environmentId, input.threadIdForSend)),
    scopedThreadKey(scopeThreadRef(input.draftThread.environmentId, input.draftThread.threadId)),
    ...(input.draftThread.promotedTo ? [scopedThreadKey(input.draftThread.promotedTo)] : []),
    ...(currentDraftSession
      ? [
          scopedThreadKey(
            scopeThreadRef(currentDraftSession.environmentId, currentDraftSession.threadId),
          ),
          ...(currentDraftSession.promotedTo
            ? [scopedThreadKey(currentDraftSession.promotedTo)]
            : []),
        ]
      : []),
  ]);
  const retryThreadId = input.bootstrapThreadDeleted ? newThreadId() : input.threadIdForSend;
  restoreFailedDraftThread(input.draftId, input.draftThread, retryThreadId);
  const restoredDraftSession = useComposerDraftStore.getState().getDraftSession(input.draftId);
  const retryThreadRef: ScopedThreadRef = scopeThreadRef(
    restoredDraftSession?.environmentId ?? input.draftThread.environmentId,
    retryThreadId,
  );
  useUiStateStore
    .getState()
    .transferTemporaryThreads([...temporaryMarkerSourceKeys], scopedThreadKey(retryThreadRef));
  clearBackgroundDraftSubmissionByRef(scopeThreadRef(input.environmentId, input.threadIdForSend));
  return retryThreadId;
}
