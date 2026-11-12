import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useTemporaryConversationStore } from "./temporary-conversation-store";

export interface ZcodeDeleteThreadOptions {
  /** Temporary conversation destruction keeps the workspace without asking. */
  readonly deleteWorktree?: boolean;
}

export const clearZcodeThreadState = (ref: ScopedThreadRef) =>
  useTemporaryConversationStore.getState().setTemporaryThread(scopedThreadKey(ref), false);
