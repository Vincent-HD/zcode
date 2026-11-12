import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DraftId,
  restoreFailedDraftThread,
  useComposerDraftStore,
  type DraftSessionState,
} from "../../composerDraftStore";
import { newThreadId } from "~/lib/utils";
import { useTemporaryConversationStore } from "../../zcode/temporary-conversation-store";
import {
  blocksTemporaryBackgroundSend,
  captureTemporaryMarkerKeys,
  isTemporaryComposerConversation,
  transferTemporaryMarkersToRestoredDraft,
} from "./useComposerSend.logic";

// Mirrors useComposerSend's failure path: capture markers, restore the draft, carry them over.
const restoreFailedDraftSend = (input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly draftId: DraftId;
  readonly draftThread: DraftSessionState;
  readonly threadIdForSend: ThreadId;
  readonly bootstrapThreadDeleted: boolean;
}) => {
  const markerKeys = captureTemporaryMarkerKeys(input);
  const retryThreadId = input.bootstrapThreadDeleted ? newThreadId() : input.threadIdForSend;
  restoreFailedDraftThread(input.draftId, input.draftThread, retryThreadId);
  transferTemporaryMarkersToRestoredDraft({ markerKeys, draftId: input.draftId });
  return retryThreadId;
};

describe("useComposerSend failure and temporary-conversation guards", () => {
  it("keeps the marker on successive bootstrap retries and blocks background dispatch", () => {
    const environmentId = EnvironmentId.make("temporary-send-env");
    const projectRef = scopeProjectRef(environmentId, ProjectId.make("temporary-send-project"));
    const draftId = DraftId.make("temporary-send-draft");
    const initialThreadId = ThreadId.make("temporary-send-bootstrap");
    const initialThreadRef = scopeThreadRef(environmentId, initialThreadId);
    const initialThreadKey = scopedThreadKey(initialThreadRef);
    const previousTemporaryKeys = useTemporaryConversationStore.getState().temporaryThreadKeys;
    const markerKeys = new Set([initialThreadKey]);
    useTemporaryConversationStore.setState((state) => ({
      ...state,
      temporaryThreadKeys: [initialThreadKey],
    }));
    useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
      threadId: initialThreadId,
    });

    try {
      const firstSentDraft = useComposerDraftStore.getState().getDraftSession(draftId);
      if (!firstSentDraft) throw new Error("Expected a draft session before the first send");

      const firstRetryThreadId = restoreFailedDraftSend({
        environmentId,
        routeThreadKey: initialThreadKey,
        draftId,
        draftThread: firstSentDraft,
        threadIdForSend: initialThreadId,
        bootstrapThreadDeleted: true,
      });
      const firstRetrySession = useComposerDraftStore.getState().getDraftSession(draftId);
      if (!firstRetrySession)
        throw new Error("Expected the first failed send to restore its draft");
      const firstRetryKey = scopedThreadKey(scopeThreadRef(environmentId, firstRetryThreadId));
      markerKeys.add(firstRetryKey);

      expect(firstRetryThreadId).not.toBe(initialThreadId);
      expect(firstRetrySession.threadId).toBe(firstRetryThreadId);
      expect(useTemporaryConversationStore.getState().temporaryThreadKeys).toEqual([firstRetryKey]);

      const secondRetryThreadId = restoreFailedDraftSend({
        environmentId,
        routeThreadKey: firstRetryKey,
        draftId,
        draftThread: firstRetrySession,
        threadIdForSend: firstRetrySession.threadId,
        bootstrapThreadDeleted: true,
      });
      const secondRetryKey = scopedThreadKey(scopeThreadRef(environmentId, secondRetryThreadId));
      markerKeys.add(secondRetryKey);
      expect(secondRetryThreadId).not.toBe(firstRetryThreadId);
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.threadId).toBe(
        secondRetryThreadId,
      );
      expect(useTemporaryConversationStore.getState().temporaryThreadKeys).toEqual([
        secondRetryKey,
      ]);

      const retryDraftSession = useComposerDraftStore.getState().getDraftSession(draftId);
      if (!retryDraftSession)
        throw new Error("Expected the second failed send to restore its draft");
      const isTemporary = () =>
        isTemporaryComposerConversation({
          routeThreadKey: secondRetryKey,
          draftId,
          draftThread: retryDraftSession,
        });

      expect(blocksTemporaryBackgroundSend("background", isTemporary)).toBe(true);
      expect(blocksTemporaryBackgroundSend("foreground", isTemporary)).toBe(false);
    } finally {
      for (const key of markerKeys) {
        useTemporaryConversationStore.getState().setTemporaryThread(key, false);
      }
      useTemporaryConversationStore.setState((state) => ({
        ...state,
        temporaryThreadKeys: previousTemporaryKeys,
      }));
      useComposerDraftStore.getState().clearDraftThread(draftId);
    }
  });
});
