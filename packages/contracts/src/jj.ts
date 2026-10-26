import * as Schema from "effect/Schema";

export const JjCommitId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
export const JjChangeId = Schema.String.check(Schema.isPattern(/^[k-z]{32}$/));
export const JjOperationId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/));
export const JjWorkspaceIdentity = Schema.Struct({
  workspaceRoot: Schema.String,
  repositoryPath: Schema.String,
  workspaceId: Schema.String,
});
export type JjWorkspaceIdentity = typeof JjWorkspaceIdentity.Type;
export const JjChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "removed", "renamed", "copied"]),
});
export const JjSignature = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  timestamp: Schema.String,
});
export type JjSignature = typeof JjSignature.Type;
export const JjRevision = Schema.Struct({
  commitId: JjCommitId,
  changeId: JjChangeId,
  parentIds: Schema.Array(JjCommitId),
  description: Schema.String,
  immutable: Schema.Boolean,
  conflict: Schema.Boolean,
  empty: Schema.Boolean,
  current: Schema.Boolean,
  files: Schema.Array(JjChangedFile),
  author: Schema.optionalKey(JjSignature),
  committer: Schema.optionalKey(JjSignature),
  bookmarks: Schema.optionalKey(Schema.Array(Schema.String)),
  remoteBookmarks: Schema.optionalKey(Schema.Array(Schema.String)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  conflictPaths: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type JjRevision = typeof JjRevision.Type;
export const JjPanelReady = Schema.Struct({
  status: Schema.Literal("ready"),
  cwd: Schema.String,
  workspaceIdentity: JjWorkspaceIdentity,
  operationId: JjOperationId,
  workingCopyCommitId: JjCommitId,
  revisions: Schema.Array(JjRevision),
  filesTruncated: Schema.Boolean,
  visibleRevisions: Schema.optionalKey(Schema.Array(JjRevision)),
  visibleRevisionsTruncated: Schema.optionalKey(Schema.Boolean),
  remotes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type JjPanelReady = typeof JjPanelReady.Type;
export const JjPanelSnapshot = Schema.Union([
  JjPanelReady,
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    cwd: Schema.String,
    reason: Schema.Literals(["missing-executable", "not-jj-workspace"]),
  }),
]);
export type JjPanelSnapshot = typeof JjPanelSnapshot.Type;
export const JjGetPanelInput = Schema.Struct({ cwd: Schema.String });
export type JjGetPanelInput = typeof JjGetPanelInput.Type;
const mutationFields = {
  cwd: Schema.String,
  workspaceIdentity: JjWorkspaceIdentity,
  expectedOperationId: JjOperationId,
};
export const JjDescribeInput = Schema.Struct({
  ...mutationFields,
  revisionCommitId: JjCommitId,
  description: Schema.String,
});
export type JjDescribeInput = typeof JjDescribeInput.Type;
export const JjSquashMessagePolicy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("keep-destination") }),
  Schema.Struct({ type: Schema.Literal("replace"), description: Schema.String }),
]);
export const JjSquashInput = Schema.Struct({
  ...mutationFields,
  sourceCommitId: JjCommitId,
  destinationCommitId: JjCommitId,
  messagePolicy: Schema.optionalKey(JjSquashMessagePolicy),
});
export type JjSquashInput = typeof JjSquashInput.Type;
// These are exact workspace-relative files, never fileset expressions or directories.
export const JjFilePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(
    /^(?!\/)(?![A-Za-z]:)(?![\s\S]*[\\\0])(?![\s\S]*(?:^|\/)(?:\.\.?|\.jj|\.git)(?:\/|$))(?![\s\S]*\/\/)(?![\s\S]*\/$)[\s\S]+$/,
  ),
);
const paths = Schema.Array(JjFilePath).check(Schema.isMinLength(1), Schema.isMaxLength(256));
const commitIds = Schema.Array(JjCommitId).check(Schema.isMinLength(1), Schema.isMaxLength(32));
export const JjBookmarkName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/),
);
export const JjRunAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("new"), parentCommitIds: commitIds }),
  Schema.Struct({ type: Schema.Literal("commit"), description: Schema.String }),
  Schema.Struct({ type: Schema.Literal("edit"), revisionCommitId: JjCommitId }),
  Schema.Struct({
    type: Schema.Literal("insert"),
    revisionCommitIds: commitIds,
    position: Schema.Literals(["before", "after"]),
  }),
  Schema.Struct({
    type: Schema.Literal("squash"),
    sourceCommitId: JjCommitId,
    destinationCommitId: JjCommitId,
    mode: Schema.Literals(["into", "onto"]),
    paths: Schema.optionalKey(paths),
    messagePolicy: Schema.optionalKey(JjSquashMessagePolicy),
  }),
  Schema.Struct({
    type: Schema.Literal("absorb"),
    revisionCommitId: JjCommitId,
    paths: Schema.optionalKey(paths),
  }),
  Schema.Struct({
    type: Schema.Literal("rebase"),
    revisionCommitId: JjCommitId,
    destinationCommitIds: commitIds,
    mode: Schema.Literals(["revision", "branch"]),
  }),
  Schema.Struct({
    type: Schema.Literal("duplicate"),
    revisionCommitId: JjCommitId,
    destinationCommitIds: Schema.optionalKey(commitIds),
  }),
  Schema.Struct({
    type: Schema.Literal("merge"),
    parentCommitIds: commitIds.check(Schema.isMinLength(2)),
  }),
  Schema.Struct({ type: Schema.Literal("abandon"), revisionCommitIds: commitIds }),
  Schema.Struct({ type: Schema.Literal("restore"), revisionCommitId: JjCommitId, paths }),
  Schema.Struct({ type: Schema.Literal("undo") }),
  Schema.Struct({ type: Schema.Literal("redo") }),
  Schema.Struct({
    type: Schema.Literal("bookmark-set"),
    name: JjBookmarkName,
    revisionCommitId: JjCommitId,
  }),
  Schema.Struct({ type: Schema.Literal("bookmark-delete"), name: JjBookmarkName }),
  Schema.Struct({
    type: Schema.Literal("bookmark-advance"),
    name: JjBookmarkName,
    revisionCommitId: JjCommitId,
  }),
  Schema.Struct({
    type: Schema.Literal("push"),
    bookmarkNames: Schema.Array(JjBookmarkName).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
    remote: JjBookmarkName,
  }),
]);
export type JjRunAction = typeof JjRunAction.Type;
export const JjRunActionInput = Schema.Struct({ ...mutationFields, action: JjRunAction });
export type JjRunActionInput = typeof JjRunActionInput.Type;
export const JjGetDiffInput = Schema.Struct({
  ...mutationFields,
  revisionCommitId: JjCommitId,
  filePath: Schema.optionalKey(JjFilePath),
});
export type JjGetDiffInput = typeof JjGetDiffInput.Type;
export const JjDiffResult = Schema.Struct({
  diff: Schema.String,
  operationId: JjOperationId,
  commitId: JjCommitId,
  truncated: Schema.Boolean,
});
export type JjDiffResult = typeof JjDiffResult.Type;
export const JjRevertOperationInput = Schema.Struct({
  ...mutationFields,
  receiptId: Schema.String,
  operationId: JjOperationId,
});
export type JjRevertOperationInput = typeof JjRevertOperationInput.Type;
export const JjActionReceipt = Schema.Struct({
  receiptId: Schema.String,
  action: Schema.Literals([
    "describe",
    "squash",
    "revert-operation",
    "new",
    "commit",
    "edit",
    "insert",
    "absorb",
    "rebase",
    "duplicate",
    "merge",
    "abandon",
    "restore",
    "undo",
    "redo",
    "bookmark-set",
    "bookmark-delete",
    "bookmark-advance",
    "push",
  ]),
  beforeOperationId: JjOperationId,
  operationId: JjOperationId,
  undoAvailable: Schema.Boolean,
});
export type JjActionReceipt = typeof JjActionReceipt.Type;
export const JjMutationResult = Schema.Struct({ panel: JjPanelReady, receipt: JjActionReceipt });
export type JjMutationResult = typeof JjMutationResult.Type;
export class JjPanelError extends Schema.TaggedError<JjPanelError>()("JjPanelError", {
  reason: Schema.Literals([
    "unavailable",
    "stale-state",
    "workspace-mismatch",
    "invalid-target",
    "invalid-path",
    "immutable",
    "conflicted",
    "invalid-receipt",
    "concurrent-operation",
    "command-failed",
    "invalid-output",
  ]),
}) {
  override get message(): string {
    return `Jujutsu panel: ${this.reason}.`;
  }
}
