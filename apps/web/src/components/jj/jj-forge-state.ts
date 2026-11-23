import type {
  JjForgePreviewInput,
  JjForgeSelection,
  JjLogRow,
  JjWorkspaceIdentity,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** The slice of the panel the publication section reads. */
export interface JjForgePanelView {
  readonly cwd: string;
  readonly workspaceIdentity: JjWorkspaceIdentity;
  readonly operationId: string;
  readonly workingCopyCommitId: string;
  readonly rows: ReadonlyArray<JjLogRow>;
  readonly remotes: ReadonlyArray<string>;
}

export const selectJjForgeChain = (
  input: {
    panel: Pick<JjForgePanelView, "rows">;
    targetCommitId: string;
    mode: JjForgePreviewInput["mode"];
    bookmarks: Readonly<Record<string, string>>;
  },
  resolve: MessageResolver = m,
): { selections: ReadonlyArray<JjForgeSelection>; issue: string | null } => {
  const revisions = input.panel.rows;
  let current = revisions.find((revision) => revision.commitId === input.targetCommitId);
  const selected: JjForgeSelection[] = [];
  const visited = new Set<string>();
  while (current && !current.immutable) {
    if (visited.has(current.commitId) || selected.length >= 32)
      return { selections: [], issue: resolve(msg("The selected chain is too large or cyclic.")) };
    visited.add(current.commitId);
    if (current.conflict)
      return {
        selections: [],
        issue: resolve(msg("Resolve revision conflicts before publishing.")),
      };
    const bookmark = input.bookmarks[current.commitId] ?? current.bookmarks?.[0];
    if (!bookmark)
      return {
        selections: [],
        issue: resolve(msg("Set a local bookmark on every selected revision first.")),
      };
    selected.unshift({ commitId: current.commitId, bookmark });
    if (input.mode === "single") return { selections: selected, issue: null };
    if (current.parentIds.length !== 1)
      return {
        selections: [],
        issue: resolve(msg("Stack publication requires a linear chain without merges.")),
      };
    const parentId = current.parentIds[0];
    if (parentId && /^0+$/.test(parentId)) break;
    current = revisions.find((revision) => revision.commitId === parentId);
    if (!current)
      return {
        selections: [],
        issue: resolve(
          msg(
            "The full chain is outside the loaded revisions. Select a shorter chain or publish one revision.",
          ),
        ),
      };
  }
  if (selected.length < (input.mode === "single" ? 1 : 2))
    return {
      selections: [],
      issue:
        input.mode === "single"
          ? resolve(msg("Select a mutable revision."))
          : resolve(msg("Select a chain with at least two mutable revisions.")),
    };
  return { selections: selected, issue: null };
};

const FORGE_REQUEST_FAILED = msg(
  "The forge request failed. Refresh the workspace and check the remote before retrying.",
);

export const jjForgeFailureMessage = (failure: unknown): string => {
  if (typeof failure !== "object" || failure === null || !("reason" in failure))
    return m(FORGE_REQUEST_FAILED);
  switch (failure.reason) {
    case "retarget-required":
      return m(
        msg(
          "An existing PR/MR targets a different base. Retarget it in the forge before publishing this chain.",
        ),
      );
    case "unsupported-forge":
      return m(
        msg(
          "Publication with PR/MR creation is supported for GitHub and GitLab. Existing review panels remain available for other forges.",
        ),
      );
    case "unsupported-destination":
      return m(
        msg(
          "This forge adapter cannot target the selected remote safely. Choose the checkout's default forge remote.",
        ),
      );
    case "destination-mismatch":
      return m(msg("The remote destination changed. Refresh and preview publication again."));
    case "workspace-mismatch":
    case "stale-state":
      return m(msg("The workspace changed. Refresh and preview publication again."));
    case "missing-bookmark":
      return m(msg("Set an unconflicted local bookmark on every selected revision first."));
    case "missing-description":
      return m(msg("Describe every selected revision before creating its PR/MR."));
    case "nonlinear-stack":
      return m(msg("Stack publication requires a linear chain without merges."));
    case "conflicted":
      return m(msg("Resolve revision conflicts before publishing."));
    case "ambiguous-pull-request":
      return m(msg("More than one PR/MR matches a bookmark. Check the forge before retrying."));
    default:
      return m(FORGE_REQUEST_FAILED);
  }
};
