import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadRouteTarget } from "./threadRoutes";

const discardingRoutes = new Set<string>();

export function shouldMountTemporaryConversationCoordinator(
  authGateStatus: "authenticated" | "hosted-static" | "guest" | "hosted-pairing" | "requires-auth",
): boolean {
  return authGateStatus === "authenticated" || authGateStatus === "hosted-static";
}

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

export interface TemporaryConversationRouteLocation {
  readonly params: Partial<Record<string, string | undefined>>;
}

export interface TemporaryConversationIdentity<TTarget = unknown> {
  readonly key: string;
  readonly aliases?: readonly string[];
  readonly target: TTarget;
}

function temporaryConversationIdentityKeys<TTarget>(
  identity: TemporaryConversationIdentity<TTarget>,
): ReadonlyArray<string> {
  return [...new Set([identity.key, ...(identity.aliases ?? [])])];
}

export function createTemporaryConversationNavigationBlocker<
  TLocation extends TemporaryConversationRouteLocation,
  TTarget,
>(options: {
  readonly resolveIdentity: (location: TLocation) => TemporaryConversationIdentity<TTarget> | null;
  readonly isTemporary: (key: string) => boolean;
  readonly confirmLeave: (identity: TemporaryConversationIdentity<TTarget>) => Promise<boolean>;
  readonly discard: (identity: TemporaryConversationIdentity<TTarget>) => Promise<boolean>;
  readonly onError?: (error: unknown) => void;
}) {
  let pending = false;

  return async (input: { current: TLocation; next: TLocation }): Promise<boolean> => {
    if (pending) return true;
    const current = options.resolveIdentity(input.current);
    const next = options.resolveIdentity(input.next);
    const currentKeys = current === null ? [] : temporaryConversationIdentityKeys(current);
    const nextKeys = new Set(next === null ? [] : temporaryConversationIdentityKeys(next));
    if (
      current === null ||
      currentKeys.some((key) => nextKeys.has(key)) ||
      !currentKeys.some(options.isTemporary)
    ) {
      return false;
    }

    pending = true;
    try {
      if (!(await options.confirmLeave(current))) return true;
      return !(await options.discard(current));
    } catch (error) {
      options.onError?.(error);
      return true;
    } finally {
      pending = false;
    }
  };
}
