import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../components/threadActionMenu.logic";
import { composerSubmissionIntentForKey } from "../composer-logic";
import { DraftId } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { isRequestedDraftRouteTarget } from "./background-draft-route";
import {
  parseTemporaryThreadKeys,
  setTemporaryThread,
  transferTemporaryThreads,
} from "./temporary-conversation-store";

const state = (temporaryThreadKeys: string[] = []) => ({ temporaryThreadKeys });

describe("temporary conversation markers", () => {
  it("keeps the temporary marker on the scoped thread key across promotion routes", () => {
    const threadKey = scopedThreadKey(
      scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1")),
    );
    const temporaryState = setTemporaryThread(state(), threadKey, true);

    expect(temporaryState.temporaryThreadKeys).toEqual([threadKey]);
    expect(setTemporaryThread(temporaryState, threadKey, true)).toBe(temporaryState);
    expect(setTemporaryThread(temporaryState, threadKey, false).temporaryThreadKeys).toEqual([]);
  });

  it("moves a temporary marker when promotion changes its scoped thread ref", () => {
    const promotedState = transferTemporaryThreads(
      state(["environment-1:reserved-thread"]),
      ["environment-1:reserved-thread"],
      "environment-2:server-thread",
    );

    expect(promotedState.temporaryThreadKeys).toEqual(["environment-2:server-thread"]);
  });

  it("moves temporary markers from bootstrap aliases through repeated retry ids", () => {
    const firstRetryState = transferTemporaryThreads(
      state(["environment-1:reserved-thread", "environment-2:promoted-thread"]),
      ["environment-1:reserved-thread", "environment-2:promoted-thread"],
      "environment-1:retry-thread-1",
    );
    const secondRetryState = transferTemporaryThreads(
      firstRetryState,
      ["environment-1:retry-thread-1"],
      "environment-1:retry-thread-2",
    );
    const permanentState = state();

    expect(firstRetryState.temporaryThreadKeys).toEqual(["environment-1:retry-thread-1"]);
    expect(secondRetryState.temporaryThreadKeys).toEqual(["environment-1:retry-thread-2"]);
    expect(
      transferTemporaryThreads(permanentState, ["environment-1:reserved-thread"], "retry-thread"),
    ).toBe(permanentState);
  });

  it("keeps only scoped thread keys from persisted markers", () => {
    expect(parseTemporaryThreadKeys(["environment-1:thread-1", "invalid", 3])).toEqual([
      "environment-1:thread-1",
    ]);
    expect(parseTemporaryThreadKeys("environment-1:thread-1")).toEqual([]);
  });
});

describe("temporary conversation entry points", () => {
  const menuState: ThreadActionMenuState = {
    canOperate: false,
    branch: null,
    projectFilter: null,
    isPinned: false,
    isSettled: false,
    autoSettleEnabled: true,
    isSnoozed: false,
    canSnoozeNow: true,
    isRegeneratingTitle: false,
    isRunning: false,
    supports: {
      settlement: true,
      autoSettleOptOut: true,
      snooze: true,
      pinning: true,
      titleRegeneration: true,
    },
    snoozePresets: [],
  };

  it("shows the reversible temporary conversation action without server permission", () => {
    const makeTemporaryItems = buildThreadActionMenuItems(menuState);
    const keepPermanentItems = buildThreadActionMenuItems({ ...menuState, isTemporary: true });

    expect(makeTemporaryItems.find((item) => item.id === "make-temporary")?.disabled).toBeFalsy();
    expect(keepPermanentItems.find((item) => item.id === "keep-permanent")?.disabled).toBeFalsy();
  });

  it("disables background send shortcuts for temporary drafts and threads", () => {
    const input = {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      platform: "Linux",
      isSoftwareKeyboardOpen: false,
      isDraftThread: false,
    };
    const backgroundEvent = {
      key: "Enter",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
    };

    expect(
      composerSubmissionIntentForKey({ ...input, isDraftThread: true, event: backgroundEvent }),
    ).toBe("background");
    expect(
      composerSubmissionIntentForKey({
        ...input,
        isDraftThread: true,
        isTemporaryConversation: true,
        event: backgroundEvent,
      }),
    ).toBeNull();
    expect(
      composerSubmissionIntentForKey({
        ...input,
        isTemporaryConversation: true,
        event: backgroundEvent,
      }),
    ).toBeNull();
  });

  it("confirms a background draft only after its returned draft route is active", () => {
    const requestedTarget = resolveThreadRouteTarget({ draftId: "draft-1" });
    const otherDraftTarget = resolveThreadRouteTarget({ draftId: "draft-2" });
    const serverTarget = resolveThreadRouteTarget({ environmentId: "env-1", threadId: "thread-1" });
    const requested = DraftId.make("draft-1");

    expect(isRequestedDraftRouteTarget(requestedTarget, requested)).toBe(true);
    expect(isRequestedDraftRouteTarget(otherDraftTarget, requested)).toBe(false);
    expect(isRequestedDraftRouteTarget(serverTarget, requested)).toBe(false);
    expect(isRequestedDraftRouteTarget(null, requested)).toBe(false);
  });
});
