import { describe, expect, it, vi } from "vite-plus/test";

import {
  createTemporaryConversationNavigationBlocker,
  isTemporaryConversationDiscarding,
  isTemporaryConversationSendBlocked,
  setTemporaryConversationDiscarding,
  temporaryConversationRouteKey,
} from "./temporaryConversationNavigation";
import { resolveThreadRouteTarget } from "./threadRoutes";

describe("temporary conversation discard navigation", () => {
  it("keeps the original route marked while deletion is in progress", () => {
    const draft = resolveThreadRouteTarget({ draftId: "draft-1" });
    const thread = resolveThreadRouteTarget({ environmentId: "environment", threadId: "thread-1" });
    expect(draft).not.toBeNull();
    expect(thread).not.toBeNull();
    if (draft === null || thread === null) return;
    const key = temporaryConversationRouteKey(draft);
    setTemporaryConversationDiscarding(key, true);
    expect(isTemporaryConversationDiscarding(draft)).toBe(true);
    expect(isTemporaryConversationDiscarding(thread)).toBe(false);
    expect(isTemporaryConversationSendBlocked({ draftId: "draft-1", threadKey: "unrelated" })).toBe(
      true,
    );
    expect(isTemporaryConversationSendBlocked({ draftId: "draft-2", threadKey: "unrelated" })).toBe(
      false,
    );
    setTemporaryConversationDiscarding(key, false);
    expect(isTemporaryConversationDiscarding(draft)).toBe(false);
    expect(isTemporaryConversationSendBlocked({ draftId: "draft-1", threadKey: "unrelated" })).toBe(
      false,
    );
    const serverKey = temporaryConversationRouteKey(thread);
    if (serverKey === null) throw new Error("Expected a server route key");
    setTemporaryConversationDiscarding(serverKey, true);
    const threadKey = serverKey.slice("thread:".length);
    expect(isTemporaryConversationSendBlocked({ draftId: null, threadKey })).toBe(true);
    setTemporaryConversationDiscarding(serverKey, false);
    expect(isTemporaryConversationSendBlocked({ draftId: null, threadKey })).toBe(false);
  });
});

type Location = {
  readonly params: {
    readonly environmentId?: string;
    readonly threadId?: string;
    readonly draftId?: string;
  };
};

type Target = {
  readonly kind: "draft" | "server";
  readonly threadKey: string;
};

function createBlocker(input: {
  readonly confirmLeave: () => Promise<boolean>;
  readonly discard: (target: Target) => Promise<boolean>;
  readonly isTemporary?: (key: string) => boolean;
}) {
  return createTemporaryConversationNavigationBlocker<Location, Target>({
    resolveIdentity: (location) => {
      if (location.params.environmentId && location.params.threadId) {
        const threadKey = `${location.params.environmentId}:${location.params.threadId}`;
        return { key: threadKey, target: { kind: "server", threadKey } };
      }
      if (location.params.draftId) {
        const threadKey = `environment:${location.params.draftId}`;
        return { key: threadKey, target: { kind: "draft", threadKey } };
      }
      return null;
    },
    isTemporary: input.isTemporary ?? (() => true),
    confirmLeave: input.confirmLeave,
    discard: (identity) => input.discard(identity.target),
  });
}

const draftLocation: Location = { params: { draftId: "thread-1" } };
const promotedThreadLocation: Location = {
  params: { environmentId: "environment", threadId: "thread-1" },
};
const destination: Location = { params: {} };

describe("temporary conversation navigation blocker", () => {
  it("keeps the draft-to-thread promotion route in the same conversation", async () => {
    const confirmLeave = vi.fn(async () => true);
    const discard = vi.fn(async (_target: Target) => true);
    const shouldBlock = createBlocker({ confirmLeave, discard });

    await expect(
      shouldBlock({ current: draftLocation, next: promotedThreadLocation }),
    ).resolves.toBe(false);
    expect(confirmLeave).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("keeps a promoted draft together when the server assigns a different scoped thread ref", async () => {
    const confirmLeave = vi.fn(async () => true);
    const discard = vi.fn(async (_target: Target) => true);
    const shouldBlock = createTemporaryConversationNavigationBlocker<Location, Target>({
      resolveIdentity: (location) => {
        if (location.params.draftId) {
          return {
            key: "environment:reserved-thread",
            aliases: ["remote:server-thread"],
            target: { kind: "draft", threadKey: "environment:reserved-thread" },
          };
        }
        if (location.params.environmentId && location.params.threadId) {
          const threadKey = `${location.params.environmentId}:${location.params.threadId}`;
          return { key: threadKey, target: { kind: "server", threadKey } };
        }
        return null;
      },
      isTemporary: (key) => key === "remote:server-thread",
      confirmLeave,
      discard: (identity) => discard(identity.target),
    });

    await expect(
      shouldBlock({
        current: { params: { draftId: "draft-1" } },
        next: { params: { environmentId: "remote", threadId: "server-thread" } },
      }),
    ).resolves.toBe(false);
    expect(confirmLeave).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("stays on the conversation when the user chooses Stay", async () => {
    const discard = vi.fn(async () => true);
    const shouldBlock = createBlocker({
      confirmLeave: async () => false,
      discard,
    });

    await expect(shouldBlock({ current: draftLocation, next: destination })).resolves.toBe(true);
    expect(discard).not.toHaveBeenCalled();
  });

  it("allows the requested destination only after deletion succeeds", async () => {
    const order: string[] = [];
    const shouldBlock = createBlocker({
      confirmLeave: async () => {
        order.push("confirm");
        return true;
      },
      discard: async (target) => {
        order.push(`delete:${target.kind}:${target.threadKey}`);
        return true;
      },
    });

    const blocked = await shouldBlock({ current: draftLocation, next: destination });

    expect(blocked).toBe(false);
    expect(order).toEqual(["confirm", "delete:draft:environment:thread-1"]);
  });

  it("keeps the current route when deletion fails", async () => {
    const shouldBlock = createBlocker({
      confirmLeave: async () => true,
      discard: async () => false,
    });

    await expect(shouldBlock({ current: promotedThreadLocation, next: destination })).resolves.toBe(
      true,
    );
  });

  it("blocks overlapping route attempts while a leave decision is pending", async () => {
    let resolveConfirmation!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const discard = vi.fn(async () => true);
    const shouldBlock = createBlocker({
      confirmLeave: () => confirmation,
      discard,
    });
    const firstAttempt = shouldBlock({ current: draftLocation, next: destination });

    await expect(
      shouldBlock({
        current: draftLocation,
        next: { params: { environmentId: "environment", threadId: "thread-2" } },
      }),
    ).resolves.toBe(true);
    resolveConfirmation(true);
    await expect(firstAttempt).resolves.toBe(false);
    expect(discard).toHaveBeenCalledOnce();
  });
});
