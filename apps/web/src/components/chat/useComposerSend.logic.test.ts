import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useUiStateStore } from "../../uiStateStore";
import {
  isTemporaryComposerConversation,
  restoreFailedDraftSend,
  runTemporaryConversationSendGuard,
} from "./useComposerSend.logic";

describe("useComposerSend failure and temporary-conversation guards", () => {
  it("keeps the marker on successive bootstrap retries and blocks background dispatch", () => {
    const environmentId = EnvironmentId.make("temporary-send-env");
    const projectRef = scopeProjectRef(environmentId, ProjectId.make("temporary-send-project"));
    const draftId = DraftId.make("temporary-send-draft");
    const initialThreadId = ThreadId.make("temporary-send-bootstrap");
    const initialThreadRef = scopeThreadRef(environmentId, initialThreadId);
    const initialThreadKey = scopedThreadKey(initialThreadRef);
    const previousTemporaryKeys = useUiStateStore.getState().temporaryThreadKeys;
    const markerKeys = new Set([initialThreadKey]);
    useUiStateStore.setState((state) => ({ ...state, temporaryThreadKeys: [initialThreadKey] }));
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
      expect(useUiStateStore.getState().temporaryThreadKeys).toEqual([firstRetryKey]);

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
      expect(useUiStateStore.getState().temporaryThreadKeys).toEqual([secondRetryKey]);

      const startThreadTurn = vi.fn(() => Promise.resolve("started"));
      const showBlockedNotice = vi.fn();
      const retryDraftSession = useComposerDraftStore.getState().getDraftSession(draftId);
      if (!retryDraftSession)
        throw new Error("Expected the second failed send to restore its draft");
      const result = runTemporaryConversationSendGuard(
        {
          submissionIntent: "background",
          isTemporaryConversation: isTemporaryComposerConversation({
            routeThreadKey: secondRetryKey,
            draftId,
            draftThread: retryDraftSession,
          }),
          onBlocked: showBlockedNotice,
        },
        startThreadTurn,
      );

      expect(result).toBeUndefined();
      expect(showBlockedNotice).toHaveBeenCalledOnce();
      expect(startThreadTurn).not.toHaveBeenCalled();
    } finally {
      for (const key of markerKeys) {
        useUiStateStore.getState().setTemporaryThread(key, false);
      }
      useUiStateStore.setState((state) => ({
        ...state,
        temporaryThreadKeys: previousTemporaryKeys,
      }));
      useComposerDraftStore.getState().clearDraftThread(draftId);
    }
  });
});
