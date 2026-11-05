import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { useUiStateStore } from "../../uiStateStore";
import { destroyTemporaryConversation } from "./temporaryConversationDestroy";

describe("destroyTemporaryConversation", () => {
  it("uses normal thread deletion without removing the thread's worktree", async () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("temporary-destroy-environment"),
      ThreadId.make("temporary-destroy-thread"),
    );
    const threadKey = scopedThreadKey(threadRef);
    const previousKeys = useUiStateStore.getState().temporaryThreadKeys;
    useUiStateStore.setState({ temporaryThreadKeys: [...previousKeys, threadKey] });
    const deleteThread = vi.fn(async () => AsyncResult.success({ sequence: 1 }));

    try {
      await expect(
        destroyTemporaryConversation({
          environmentId: threadRef.environmentId,
          routeKind: "server",
          draftId: null,
          draftThread: null,
          routeThreadRef: threadRef,
          routeThreadKey: threadKey,
          temporaryThreadKeys: [threadKey],
          deleteThread,
          startNewThread: async () => null,
          navigateAway: async () => undefined,
        }),
      ).resolves.toBe(true);

      expect(deleteThread).toHaveBeenCalledWith(threadRef, { deleteWorktree: false });
      expect(useUiStateStore.getState().temporaryThreadKeys).not.toContain(threadKey);
    } finally {
      useUiStateStore.setState({ temporaryThreadKeys: previousKeys });
    }
  });
});
