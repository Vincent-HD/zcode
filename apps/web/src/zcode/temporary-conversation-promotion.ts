import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useTemporaryConversationStore } from "./temporary-conversation-store";

/** Carries a draft's temporary marker onto the server thread it was promoted to. */
export const useTemporaryMarkerPromotion = (
  draftSession: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly promotedTo?: ScopedThreadRef | null | undefined;
  } | null,
) => {
  const reservedDraftThreadKey = draftSession
    ? scopedThreadKey(scopeThreadRef(draftSession.environmentId, draftSession.threadId))
    : null;
  const promotedDraftThreadKey = draftSession?.promotedTo
    ? scopedThreadKey(draftSession.promotedTo)
    : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- carries the temporary marker across draft promotion
  useEffect(() => {
    if (
      reservedDraftThreadKey === null ||
      promotedDraftThreadKey === null ||
      reservedDraftThreadKey === promotedDraftThreadKey
    ) {
      return;
    }
    useTemporaryConversationStore
      .getState()
      .transferTemporaryThread(reservedDraftThreadKey, promotedDraftThreadKey);
  }, [promotedDraftThreadKey, reservedDraftThreadKey]);
};
