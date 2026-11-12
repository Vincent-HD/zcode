import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import {
  captureTemporaryMarkerKeys,
  blocksTemporaryBackgroundSend,
  isTemporaryComposerConversation,
  transferTemporaryMarkersToRestoredDraft,
} from "../components/chat/useComposerSend.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { ComposerSubmissionIntent } from "../composer-logic";
import {
  clearBackgroundDraftSubmissionByRef,
  type DraftId,
  type DraftSessionState,
} from "../composerDraftStore";
import { isTemporaryConversationSendBlocked } from "../temporaryConversationNavigation";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { isRequestedDraftRouteTarget } from "./background-draft-route";
import { draftSendState } from "../components/chat/chatViewSend";
import { beginFanoutSend, registerSendInFlightProbe } from "./temporary-conversation-send";

registerSendInFlightProbe((routeKey) => draftSendState(routeKey).sendInFlight.current);

const KEPT_IN_CONVERSATION = {
  title: "Message started in this conversation",
  description: "Temporary conversations stay open while a message is submitted.",
};

/** Temporary-conversation guards for one composer's sends. */
export const useTemporaryComposerSend = (input: {
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
}) => {
  const router = useRouter();
  const { routeThreadKey, draftId, draftThread } = input;
  const isTemporary = () =>
    isTemporaryComposerConversation({ routeThreadKey, draftId, draftThread });
  const isDiscarding = () => {
    if (!isTemporaryConversationSendBlocked({ draftId, threadKey: routeThreadKey })) return false;
    toastManager.add({ type: "warning", title: "This temporary conversation is being discarded" });
    return true;
  };
  const blockedBackgroundDrafts = new Set<ScopedThreadRef>();
  return {
    blocksSend: (submissionIntent: ComposerSubmissionIntent) => {
      if (isDiscarding()) return true;
      if (!blocksTemporaryBackgroundSend(submissionIntent, isTemporary)) return false;
      toastManager.add({
        type: "warning",
        title: "Background sends are unavailable for temporary conversations",
      });
      return true;
    },
    blocksDispatch: (multipleModels: boolean) => {
      if (isDiscarding()) return true;
      if (!multipleModels || !isTemporary()) return false;
      toastManager.add({
        type: "warning",
        title: "Multiple-model sends are unavailable for temporary conversations",
      });
      return true;
    },
    beginFanout: () => beginFanoutSend(routeThreadKey),
    /** Opens the fresh composer for a background send unless the conversation is temporary. */
    openBackgroundDraft: async (
      backgroundThreadRef: ScopedThreadRef,
      open: () => Promise<{ readonly draftId: DraftId } | null>,
    ) => {
      if (isTemporary()) {
        clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
        blockedBackgroundDrafts.add(backgroundThreadRef);
        return false;
      }
      const openedDraft = await open();
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const opened = isRequestedDraftRouteTarget(
        resolveThreadRouteTarget(currentRouteParams),
        openedDraft?.draftId,
      );
      if (opened) return true;
      if (isTemporary()) blockedBackgroundDrafts.add(backgroundThreadRef);
      else {
        toastManager.add(
          stackedThreadToast({ type: "warning", title: "Could not open a fresh composer" }),
        );
      }
      return false;
    },
    announceKeptBackgroundSend: (backgroundThreadRef: ScopedThreadRef) => {
      if (!blockedBackgroundDrafts.delete(backgroundThreadRef)) return;
      toastManager.add(stackedThreadToast({ type: "info", ...KEPT_IN_CONVERSATION }));
    },
    startFreshComposer: (startNewThread: () => void) => {
      if (!isTemporary()) return startNewThread();
      toastManager.add({ type: "info", ...KEPT_IN_CONVERSATION });
    },
    captureMarkers: (environmentId: ScopedThreadRef["environmentId"], threadIdForSend: ThreadId) =>
      draftId && draftThread
        ? captureTemporaryMarkerKeys({
            environmentId,
            routeThreadKey,
            draftId,
            draftThread,
            threadIdForSend,
          })
        : [],
    restoreMarkers: (markerKeys: ReadonlyArray<string>) => {
      if (draftId) transferTemporaryMarkersToRestoredDraft({ markerKeys, draftId });
    },
  };
};
