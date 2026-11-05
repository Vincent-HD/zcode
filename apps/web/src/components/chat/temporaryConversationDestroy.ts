import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  useComposerDraftStore,
  type DraftId,
  type DraftThreadState,
} from "../../composerDraftStore";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { readThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import {
  setTemporaryConversationDiscarding,
  temporaryConversationRouteKey,
} from "../../temporaryConversationNavigation";
import type { useThreadActions } from "../../hooks/useThreadActions";
import type { NewThreadHandler } from "../../hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { hasPendingDraftSend } from "./chatViewSend";

type DeleteThreadAction = ReturnType<typeof useThreadActions>["deleteThread"];

export async function destroyTemporaryConversation(input: {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly draftId: DraftId | null;
  readonly draftThread: DraftThreadState | null;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly temporaryThreadKeys: ReadonlyArray<string>;
  readonly deleteThread: DeleteThreadAction;
  readonly startNewThread: NewThreadHandler;
  readonly navigateAway: () => Promise<unknown>;
}): Promise<boolean> {
  if (input.temporaryThreadKeys.some(hasPendingDraftSend)) {
    toastManager.add({ type: "warning", title: "Wait for the message to finish sending" });
    return false;
  }

  const routeTarget =
    input.routeKind === "draft" && input.draftId !== null
      ? { kind: "draft" as const, draftId: input.draftId }
      : { kind: "server" as const, threadRef: input.routeThreadRef };
  const discardKey = temporaryConversationRouteKey(routeTarget);
  setTemporaryConversationDiscarding(discardKey, true);
  try {
    if (
      input.routeKind === "draft" &&
      input.draftId !== null &&
      !input.draftThread?.promotedTo &&
      readThreadShell(input.routeThreadRef) === null
    ) {
      releaseComposerDraftUploads(input.draftId);
      useComposerDraftStore.getState().clearDraftThread(input.draftId);
      for (const key of input.temporaryThreadKeys) {
        useUiStateStore.getState().setTemporaryThread(key, false);
      }
      if (input.draftThread !== null) {
        await input.startNewThread(
          scopeProjectRef(input.environmentId, input.draftThread.projectId),
          {
            replace: true,
          },
        );
      } else {
        await input.navigateAway();
      }
      return true;
    }

    const target = input.draftThread?.promotedTo ?? input.routeThreadRef;
    const result = await input.deleteThread(target, { deleteWorktree: false });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to destroy temporary conversation",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return false;
    }
    if (input.draftId !== null) {
      releaseComposerDraftUploads(input.draftId);
      useComposerDraftStore.getState().clearDraftThread(input.draftId);
    }
    for (const key of [...input.temporaryThreadKeys, scopedThreadKey(target)]) {
      useUiStateStore.getState().setTemporaryThread(key, false);
    }
    if (input.draftId !== null && scopedThreadKey(target) !== input.routeThreadKey) {
      await input.navigateAway();
    }
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to destroy temporary conversation",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    return false;
  } finally {
    setTemporaryConversationDiscarding(discardKey, false);
  }
}
