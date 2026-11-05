import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadRouteTarget } from "./threadRoutes";

const discardingRoutes = new Set<string>();

export function temporaryConversationRouteKey(target: ThreadRouteTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "draft"
    ? `draft:${target.draftId}`
    : `thread:${scopedThreadKey(target.threadRef)}`;
}

export function setTemporaryConversationDiscarding(key: string | null, discarding: boolean): void {
  if (key === null) return;
  if (discarding) discardingRoutes.add(key);
  else discardingRoutes.delete(key);
}

export function isTemporaryConversationDiscarding(target: ThreadRouteTarget): boolean {
  const key = temporaryConversationRouteKey(target);
  return key !== null && discardingRoutes.has(key);
}

export function isTemporaryConversationSendBlocked(input: {
  readonly draftId: string | null;
  readonly threadKey: string;
}): boolean {
  return (
    discardingRoutes.has(`thread:${input.threadKey}`) ||
    (input.draftId !== null && discardingRoutes.has(`draft:${input.draftId}`))
  );
}
