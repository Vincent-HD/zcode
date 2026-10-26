import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { useComposerDraftStore } from "../composerDraftStore";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { readThreadShell } from "../state/entities";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useThreadActions } from "../hooks/useThreadActions";
import { useStableCallback } from "../hooks/useStableCallback";
import { useUiStateStore } from "../uiStateStore";
import { hasPendingDraftSend } from "./chat/chatViewSend";
import {
  createTemporaryConversationNavigationBlocker,
  setTemporaryConversationDiscarding,
  temporaryConversationRouteKey,
  type TemporaryConversationIdentity,
} from "../temporaryConversationNavigation";

type TemporaryRouteIdentity = TemporaryConversationIdentity<ThreadRouteTarget>;
type TemporaryRouteLocation = {
  readonly params: Partial<Record<string, string | undefined>>;
};
type TemporaryRouteBlocker = (input: {
  readonly current: TemporaryRouteLocation;
  readonly next: TemporaryRouteLocation;
}) => Promise<boolean>;

function resolveTemporaryRouteIdentity(
  params: Partial<Record<string, string | undefined>>,
): TemporaryRouteIdentity | null {
  const target = resolveThreadRouteTarget(params);
  if (!target) return null;
  if (target.kind === "server") {
    return { key: scopedThreadKey(target.threadRef), target };
  }
  const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
  if (!session) return null;
  const threadKey = scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId));
  const promotedThreadKey = session.promotedTo ? scopedThreadKey(session.promotedTo) : null;
  return {
    key: threadKey,
    ...(promotedThreadKey && promotedThreadKey !== threadKey
      ? { aliases: [promotedThreadKey] }
      : {}),
    target,
  };
}

function temporaryThreadRefForTarget(target: ThreadRouteTarget) {
  if (target.kind === "server") return target.threadRef;
  const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
  if (!session) return null;
  return session.promotedTo ?? scopeThreadRef(session.environmentId, session.threadId);
}

export function TemporaryConversationCoordinator() {
  const routeTarget = useThreadRouteTarget();
  const { deleteThread } = useThreadActions();
  const stableDeleteThread = useStableCallback(deleteThread);
  const [navigationBlocker] = useState<TemporaryRouteBlocker>(() =>
    createTemporaryConversationNavigationBlocker({
      resolveIdentity: (location) => resolveTemporaryRouteIdentity(location.params),
      isTemporary: (key) => useUiStateStore.getState().temporaryThreadKeys.includes(key),
      confirmLeave: async () => {
        const confirmation = requestConfirmDialog(
          [
            "Leave this temporary conversation?",
            "T3 will remove this conversation from your history and clean its linked files. Some T3 and provider data may remain.",
          ].join("\n"),
          {
            variant: "destructive",
            cancelLabel: "Stay",
            confirmLabel: "Leave and discard",
          },
        );
        return confirmation ? await confirmation : false;
      },
      discard: async (identity) => {
        if ([identity.key, ...(identity.aliases ?? [])].some(hasPendingDraftSend)) {
          toastManager.add({ type: "warning", title: "Wait for the message to finish sending" });
          return false;
        }
        const threadRef = temporaryThreadRefForTarget(identity.target);
        if (!threadRef) return false;
        const discardKey = temporaryConversationRouteKey(identity.target);
        setTemporaryConversationDiscarding(discardKey, true);
        try {
          const draftSession =
            identity.target.kind === "draft"
              ? useComposerDraftStore.getState().getDraftSession(identity.target.draftId)
              : null;

          if (
            identity.target.kind === "draft" &&
            !draftSession?.promotedTo &&
            readThreadShell(threadRef) === null
          ) {
            releaseComposerDraftUploads(identity.target.draftId);
            useComposerDraftStore.getState().clearDraftThread(identity.target.draftId);
            for (const key of [identity.key, ...(identity.aliases ?? [])]) {
              useUiStateStore.getState().setTemporaryThread(key, false);
            }
            return true;
          }

          const result = await stableDeleteThread(threadRef, {
            navigateToFallback: false,
            deleteWorktree: false,
          });
          if (result._tag === "Failure") {
            setTemporaryConversationDiscarding(discardKey, false);
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to discard temporary conversation",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return false;
          }

          if (identity.target.kind === "draft") {
            releaseComposerDraftUploads(identity.target.draftId);
            useComposerDraftStore.getState().clearDraftThread(identity.target.draftId);
          }
          for (const key of [
            identity.key,
            ...(identity.aliases ?? []),
            scopedThreadKey(threadRef),
          ]) {
            useUiStateStore.getState().setTemporaryThread(key, false);
          }
          return true;
        } catch (error) {
          setTemporaryConversationDiscarding(discardKey, false);
          throw error;
        }
      },
      onError: (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to discard temporary conversation",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    }),
  );

  const shouldBlockFn: ShouldBlockFn = useStableCallback((input: Parameters<ShouldBlockFn>[0]) =>
    navigationBlocker(input),
  );
  useBlocker({ shouldBlockFn, enableBeforeUnload: false });

  const routeKey = temporaryConversationRouteKey(routeTarget);
  useEffect(() => () => setTemporaryConversationDiscarding(routeKey, false), [routeKey]);

  const threadRef = routeTarget ? temporaryThreadRefForTarget(routeTarget) : null;
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const isTemporary = useUiStateStore((state) =>
    threadKey === null ? false : state.temporaryThreadKeys.includes(threadKey),
  );

  useEffect(() => {
    if (!isTemporary) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isTemporary]);

  return null;
}
