import { describe, expect, it } from "vite-plus/test";

import {
  isTemporaryConversationDiscarding,
  isTemporaryConversationSendBlocked,
  setTemporaryConversationDiscarding,
  temporaryConversationRouteKey,
} from "./temporaryConversationNavigation";
import { resolveThreadRouteTarget } from "./threadRoutes";

describe("temporary conversation destroy state", () => {
  it("blocks sends only while an explicit destroy is in progress", () => {
    const draft = resolveThreadRouteTarget({ draftId: "draft-1" });
    const thread = resolveThreadRouteTarget({ environmentId: "environment", threadId: "thread-1" });
    expect(draft).not.toBeNull();
    expect(thread).not.toBeNull();
    if (draft === null || thread === null) return;

    const draftKey = temporaryConversationRouteKey(draft);
    setTemporaryConversationDiscarding(draftKey, true);
    expect(isTemporaryConversationDiscarding(draft)).toBe(true);
    expect(isTemporaryConversationDiscarding(thread)).toBe(false);
    expect(isTemporaryConversationSendBlocked({ draftId: "draft-1", threadKey: "unrelated" })).toBe(
      true,
    );
    setTemporaryConversationDiscarding(draftKey, false);
    expect(isTemporaryConversationDiscarding(draft)).toBe(false);
    expect(isTemporaryConversationSendBlocked({ draftId: "draft-1", threadKey: "unrelated" })).toBe(
      false,
    );

    const threadKey = temporaryConversationRouteKey(thread);
    if (threadKey === null) throw new Error("Expected a server route key");
    setTemporaryConversationDiscarding(threadKey, true);
    expect(
      isTemporaryConversationSendBlocked({ draftId: null, threadKey: threadKey.slice(7) }),
    ).toBe(true);
    setTemporaryConversationDiscarding(threadKey, false);
    expect(
      isTemporaryConversationSendBlocked({ draftId: null, threadKey: threadKey.slice(7) }),
    ).toBe(false);
  });
});
