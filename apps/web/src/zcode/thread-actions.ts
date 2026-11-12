import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { hasPendingDraftSend } from "./temporary-conversation-send";
import {
  isTemporaryThreadKey,
  useTemporaryConversationStore,
} from "./temporary-conversation-store";

export const markConversationTemporary = (threadKeys: ReadonlyArray<string>) => {
  if (threadKeys.some(hasPendingDraftSend)) {
    toastManager.add({ type: "warning", title: "Wait for the message to finish sending" });
    return;
  }
  for (const key of threadKeys) {
    useTemporaryConversationStore.getState().setTemporaryThread(key, true);
  }
  toastManager.add({ type: "success", title: "Conversation marked temporary" });
};

export const keepConversationPermanent = (threadKeys: ReadonlyArray<string>) => {
  for (const key of threadKeys) {
    useTemporaryConversationStore.getState().setTemporaryThread(key, false);
  }
  toastManager.add({ type: "success", title: "Conversation will be kept" });
};

/** Handles a fork thread action; returns false for upstream actions. */
export const handleZcodeThreadAction = (action: string, threadKey: string) => {
  if (action === "make-temporary") markConversationTemporary([threadKey]);
  else if (action === "keep-permanent") keepConversationPermanent([threadKey]);
  else return false;
  return true;
};

export const handleZcodeThreadRefAction = (action: string, threadRef: ScopedThreadRef) =>
  handleZcodeThreadAction(action, scopedThreadKey(threadRef));

export const isTemporaryThreadRef = (threadRef: ScopedThreadRef) =>
  isTemporaryThreadKey(scopedThreadKey(threadRef));
