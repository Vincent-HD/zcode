import type { JjPanelReady } from "@t3tools/contracts";
import type { JjForgeSelection, JjForgePreviewInput } from "@t3tools/contracts";

export const selectJjForgeChain = (input: {
  panel: JjPanelReady;
  targetCommitId: string;
  mode: JjForgePreviewInput["mode"];
  bookmarks: Readonly<Record<string, string>>;
}): { selections: ReadonlyArray<JjForgeSelection>; issue: string | null } => {
  const revisions = [...input.panel.revisions, ...(input.panel.visibleRevisions ?? [])];
  let current = revisions.find((revision) => revision.commitId === input.targetCommitId);
  const selected: JjForgeSelection[] = [];
  const visited = new Set<string>();
  while (current && !current.immutable) {
    if (visited.has(current.commitId) || selected.length >= 32)
      return { selections: [], issue: "The selected chain is too large or cyclic." };
    visited.add(current.commitId);
    if (current.conflict)
      return { selections: [], issue: "Resolve revision conflicts before publishing." };
    const bookmark = input.bookmarks[current.commitId] ?? current.bookmarks?.[0];
    if (!bookmark)
      return { selections: [], issue: "Set a local bookmark on every selected revision first." };
    selected.unshift({ commitId: current.commitId, bookmark });
    if (input.mode === "single") return { selections: selected, issue: null };
    if (current.parentIds.length !== 1)
      return { selections: [], issue: "Stack publication requires a linear chain without merges." };
    const parentId = current.parentIds[0];
    if (parentId && /^0+$/.test(parentId)) break;
    current = revisions.find((revision) => revision.commitId === parentId);
    if (!current)
      return {
        selections: [],
        issue:
          "The full chain is outside the loaded revisions. Select a shorter chain or publish one revision.",
      };
  }
  if (selected.length < (input.mode === "single" ? 1 : 2))
    return {
      selections: [],
      issue:
        input.mode === "single"
          ? "Select a mutable revision."
          : "Select a chain with at least two mutable revisions.",
    };
  return { selections: selected, issue: null };
};

export const jjForgeFailureMessage = (failure: unknown): string => {
  if (typeof failure !== "object" || failure === null || !("reason" in failure))
    return "The forge request failed. Refresh the workspace and check the remote before retrying.";
  switch (failure.reason) {
    case "retarget-required":
      return "An existing PR/MR targets a different base. Retarget it in the forge before publishing this chain.";
    case "unsupported-forge":
      return "Publication with PR/MR creation is supported for GitHub and GitLab. Existing review panels remain available for other forges.";
    case "unsupported-destination":
      return "This forge adapter cannot target the selected remote safely. Choose the checkout's default forge remote.";
    case "destination-mismatch":
      return "The remote destination changed. Refresh and preview publication again.";
    case "workspace-mismatch":
    case "stale-state":
      return "The workspace changed. Refresh and preview publication again.";
    case "missing-bookmark":
      return "Set an unconflicted local bookmark on every selected revision first.";
    case "missing-description":
      return "Describe every selected revision before creating its PR/MR.";
    case "nonlinear-stack":
      return "Stack publication requires a linear chain without merges.";
    case "conflicted":
      return "Resolve revision conflicts before publishing.";
    case "ambiguous-pull-request":
      return "More than one PR/MR matches a bookmark. Check the forge before retrying.";
    default:
      return "The forge request failed. Refresh the workspace and check the remote before retrying.";
  }
};
