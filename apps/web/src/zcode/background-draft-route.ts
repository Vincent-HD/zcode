import type { DraftId } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";

/** A background send opened a fresh composer only once its returned draft route is active. */
export const isRequestedDraftRouteTarget = (
  target: ThreadRouteTarget | null,
  draftId: DraftId | null | undefined,
): boolean =>
  draftId !== null &&
  draftId !== undefined &&
  target?.kind === "draft" &&
  target.draftId === draftId;
