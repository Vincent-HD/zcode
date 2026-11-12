import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import {
  useComposerDraftStore,
  type DraftSessionState,
  type DraftId,
} from "../../composerDraftStore";
import { useTemporaryConversationStore } from "../../zcode/temporary-conversation-store";

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
  const temporaryThreadKeys = useTemporaryConversationStore.getState().temporaryThreadKeys;
  return [...threadKeys].some((key) => temporaryThreadKeys.includes(key));
}

/** Temporary conversations stay open, so they never send in the background. */
export function blocksTemporaryBackgroundSend(
  submissionIntent: ComposerSubmissionIntent,
  isTemporaryConversation: () => boolean,
): boolean {
  return submissionIntent === "background" && isTemporaryConversation();
}

/** Thread keys that may hold a draft's temporary marker before a failed send restores it. */
export function captureTemporaryMarkerKeys(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly draftId: DraftId;
  readonly draftThread: DraftSessionState;
  readonly threadIdForSend: ThreadId;
}): ReadonlyArray<string> {
  const currentDraftSession = useComposerDraftStore.getState().getDraftSession(input.draftId);
  return [
    ...new Set([
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
    ]),
  ];
}

/** Carries captured temporary markers onto the thread id the restored draft retries with. */
export function transferTemporaryMarkersToRestoredDraft(input: {
  readonly markerKeys: ReadonlyArray<string>;
  readonly draftId: DraftId;
}): void {
  const restoredDraftSession = useComposerDraftStore.getState().getDraftSession(input.draftId);
  if (!restoredDraftSession) return;
  const retryThreadRef: ScopedThreadRef = scopeThreadRef(
    restoredDraftSession.environmentId,
    restoredDraftSession.threadId,
  );
  useTemporaryConversationStore
    .getState()
    .transferTemporaryThreads(input.markerKeys, scopedThreadKey(retryThreadRef));
}
