import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { ChangeRequest, SourceControlProviderKind } from "./sourceControl.ts";
import { PullRequestRef, PullRequestSummary } from "./pullRequest.ts";
import { JjCommitId, JjOperationId, JjWorkspaceIdentity, type JjPanelReady } from "./jj.ts";

export const JjForgeBookmark = Schema.String.check(
  Schema.isPattern(
    /^(?!.*\.\.)(?!.*\/\/)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}(?<![/.])$/,
  ),
);
export const JjForgeSelection = Schema.Struct({ commitId: JjCommitId, bookmark: JjForgeBookmark });
export type JjForgeSelection = typeof JjForgeSelection.Type;
const contextFields = {
  cwd: Schema.String,
  workspaceIdentity: JjWorkspaceIdentity,
  expectedOperationId: JjOperationId,
  projectId: ProjectId,
  remote: JjForgeBookmark,
};
export const JjForgePreviewInput = Schema.Struct({
  ...contextFields,
  mode: Schema.Literals(["single", "linear-stack"]),
  baseBookmark: JjForgeBookmark,
  // Bottom to top, with an explicit bookmark choice even when a revision has several.
  selections: Schema.Array(JjForgeSelection).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type JjForgePreviewInput = typeof JjForgePreviewInput.Type;
export const JjForgeDestination = Schema.Struct({
  remote: JjForgeBookmark,
  provider: SourceControlProviderKind,
  host: Schema.String,
  repository: Schema.String,
});
export type JjForgeDestination = typeof JjForgeDestination.Type;
export const JjForgeLayer = Schema.Struct({
  ...JjForgeSelection.fields,
  baseBookmark: JjForgeBookmark,
  title: Schema.String,
  body: Schema.String,
  existing: Schema.NullOr(ChangeRequest),
});
export type JjForgeLayer = typeof JjForgeLayer.Type;
export const JjForgePlan = Schema.Struct({
  input: JjForgePreviewInput,
  destination: JjForgeDestination,
  layers: Schema.Array(JjForgeLayer),
});
export type JjForgePlan = typeof JjForgePlan.Type;
export const JjForgePublishInput = Schema.Struct({
  ...JjForgePreviewInput.fields,
  expectedDestination: JjForgeDestination,
});
export type JjForgePublishInput = typeof JjForgePublishInput.Type;
export const JjForgePublishedLayer = Schema.Struct({
  ...JjForgeSelection.fields,
  baseBookmark: JjForgeBookmark,
  reference: PullRequestRef,
  url: Schema.String,
  created: Schema.Boolean,
});
export const JjForgePublishResult = Schema.Struct({
  // A failed sync may follow a successful push; remote side effects cannot be undone locally.
  pushed: Schema.Boolean,
  operationId: JjOperationId,
  layers: Schema.Array(JjForgePublishedLayer),
  failedBookmark: Schema.NullOr(JjForgeBookmark),
});
export type JjForgePublishResult = typeof JjForgePublishResult.Type;
export const JjForgeStatusInput = Schema.Struct({
  ...contextFields,
  revisionCommitIds: Schema.Array(JjCommitId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type JjForgeStatusInput = typeof JjForgeStatusInput.Type;
export const JjForgeRevisionStatus = Schema.Struct({
  ...JjForgeSelection.fields,
  reference: PullRequestRef,
  summary: PullRequestSummary,
  headMatches: Schema.NullOr(Schema.Boolean),
  unresolvedThreadCount: Schema.NullOr(Schema.Number),
  reviewThreadsTruncated: Schema.Boolean,
});
export type JjForgeRevisionStatus = typeof JjForgeRevisionStatus.Type;
export const JjForgeStatusResult = Schema.Struct({
  destination: JjForgeDestination,
  revisions: Schema.Array(JjForgeRevisionStatus),
  unavailableBookmarks: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});
export type JjForgeStatusResult = typeof JjForgeStatusResult.Type;
export class JjForgeError extends Schema.TaggedError<JjForgeError>()("JjForgeError", {
  reason: Schema.Literals([
    "unavailable",
    "workspace-mismatch",
    "stale-state",
    "invalid-selection",
    "nonlinear-stack",
    "duplicate-bookmark",
    "missing-bookmark",
    "conflicted",
    "immutable",
    "missing-description",
    "unsupported-forge",
    "destination-mismatch",
    "unsupported-destination",
    "retarget-required",
    "ambiguous-pull-request",
    "provider-failed",
    "command-failed",
    "invalid-output",
  ]),
}) {
  override get message(): string {
    return `Jujutsu publication: ${this.reason}.`;
  }
}

/** Build only the requested chain; never infer bookmarks or a base from the current branch. */
export const buildJjForgeLayers = (input: {
  request: JjForgePreviewInput;
  panel: JjPanelReady;
  provider: SourceControlProviderKind;
}): ReadonlyArray<JjForgeLayer> => {
  const fail = (reason: JjForgeError["reason"]): never => {
    throw new JjForgeError({ reason });
  };
  if (input.provider !== "github" && input.provider !== "gitlab") fail("unsupported-forge");
  const selections = input.request.selections;
  if (
    !selections.length ||
    selections.length > 32 ||
    (input.request.mode === "single" && selections.length !== 1) ||
    (input.request.mode === "linear-stack" && selections.length < 2)
  )
    fail("invalid-selection");
  if (
    new Set(selections.map((selection) => selection.bookmark)).size !== selections.length ||
    selections.some((selection) => selection.bookmark === input.request.baseBookmark)
  )
    fail("duplicate-bookmark");
  if (new Set(selections.map((selection) => selection.commitId)).size !== selections.length)
    fail("invalid-selection");
  const revisions = [...input.panel.revisions, ...(input.panel.visibleRevisions ?? [])];
  return selections.map((selection, index) => {
    const revision = revisions.find((candidate) => candidate.commitId === selection.commitId);
    if (!revision) return fail("invalid-selection");
    if (revision.immutable || /^0+$/.test(revision.commitId)) fail("immutable");
    if (revision.conflict) fail("conflicted");
    if (!revision.bookmarks?.includes(selection.bookmark)) fail("missing-bookmark");
    if (
      input.request.mode === "linear-stack" &&
      (revision.parentIds.length !== 1 ||
        (index > 0 && revision.parentIds[0] !== selections[index - 1]?.commitId))
    )
      fail("nonlinear-stack");
    const lines = revision.description.trim().split("\n");
    const title = lines[0]?.trim();
    if (!title) return fail("missing-description");
    return {
      ...selection,
      baseBookmark: selections[index - 1]?.bookmark ?? input.request.baseBookmark,
      title,
      body: lines.slice(1).join("\n").trim(),
      existing: null,
    };
  });
};
