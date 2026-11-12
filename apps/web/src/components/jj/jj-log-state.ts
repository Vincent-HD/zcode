import type { JjGetPanelInput, JjPanelReady, JjPanelSnapshot } from "@t3tools/contracts";

export const JJ_LOG_PAGE = 100;

export interface JjLogView {
  /** Undefined follows the workspace's configured `revsets.log`. */
  readonly revset: string | undefined;
  readonly limit: number;
}

/** The getPanel input that lets the server skip work the client already holds. */
export const jjRefreshInput = (input: {
  cwd: string;
  view: JjLogView;
  current: JjPanelReady | null;
}): JjGetPanelInput => ({
  cwd: input.cwd,
  ...(input.view.revset !== undefined ? { revset: input.view.revset } : {}),
  limit: input.view.limit,
  ...(input.current
    ? {
        knownOperationId: input.current.operationId,
        loadedCount: input.current.hasMore ? input.current.rows.length : input.view.limit,
      }
    : {}),
});

export type JjSnapshotMerge =
  | { readonly type: "keep" }
  | { readonly type: "replace"; readonly panel: JjPanelReady }
  | { readonly type: "unavailable"; readonly reason: "missing-executable" | "not-jj-workspace" }
  /** An unchanged or appended page no longer lines up with the held rows. */
  | { readonly type: "reload" };

export const mergeJjSnapshot = (
  current: JjPanelReady | null,
  next: JjPanelSnapshot,
): JjSnapshotMerge => {
  if (next.status === "unavailable") return { type: "unavailable", reason: next.reason };
  if (next.status === "unchanged")
    return current?.operationId === next.operationId ? { type: "keep" } : { type: "reload" };
  if (next.offset === 0) return { type: "replace", panel: next };
  if (current?.operationId !== next.operationId || current.rows.length !== next.offset)
    return { type: "reload" };
  return {
    type: "replace",
    panel: { ...next, offset: 0, rows: [...current.rows, ...next.rows] },
  };
};
