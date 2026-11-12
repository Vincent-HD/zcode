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
export type JjChangedFile = typeof JjChangedFile.Type;
export const JjSignature = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  timestamp: Schema.String,
});
export type JjSignature = typeof JjSignature.Type;

const flag = Schema.optionalKey(Schema.Boolean);
const names = Schema.optionalKey(Schema.Array(Schema.String));
export const JjLogEdge = Schema.Struct({ commitId: JjCommitId, elided: flag });
export type JjLogEdge = typeof JjLogEdge.Type;
/** One graph row. False flags and empty lists are omitted to keep remote payloads small. */
export const JjLogRow = Schema.Struct({
  commitId: JjCommitId,
  changeId: JjChangeId,
  parentIds: Schema.Array(JjCommitId),
  /** Present only when a parent is outside the revset: graph edges to the nearest visible ancestors. */
  edges: Schema.optionalKey(Schema.Array(JjLogEdge)),
  /** Some ancestry leaves the revset without reaching a visible ancestor. */
  edgesTruncated: flag,
  summary: Schema.String,
  author: JjSignature,
  changePrefixLength: Schema.Number,
  commitPrefixLength: Schema.Number,
  /** Set only for divergent changes, rendered as `change/offset`. */
  changeOffset: Schema.optionalKey(Schema.Number),
  current: flag,
  immutable: flag,
  conflict: flag,
  empty: flag,
  divergent: flag,
  hidden: flag,
  root: flag,
  bookmarks: names,
  remoteBookmarks: names,
  tags: names,
  workingCopies: names,
});
export type JjLogRow = typeof JjLogRow.Type;
export const JjRevisionDetails = Schema.Struct({
  commitId: JjCommitId,
  changeId: JjChangeId,
  description: Schema.String,
  author: JjSignature,
  committer: JjSignature,
  files: Schema.Array(JjChangedFile),
  filesTruncated: Schema.Boolean,
  conflictPaths: Schema.Array(Schema.String),
});
export type JjRevisionDetails = typeof JjRevisionDetails.Type;
// Control characters cannot be quoted safely into jj template string literals.
export const JjRevset = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
export const JjLogLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 }));
export const JjLogView = Schema.Struct({
  revset: Schema.optionalKey(JjRevset),
  limit: Schema.optionalKey(JjLogLimit),
});
export type JjLogView = typeof JjLogView.Type;
export const JjPanelReady = Schema.Struct({
  status: Schema.Literal("ready"),
  cwd: Schema.String,
  workspaceIdentity: JjWorkspaceIdentity,
  operationId: JjOperationId,
  operationDescription: Schema.String,
  workingCopyCommitId: JjCommitId,
  /** The effective revset: the requested one, or the workspace's `revsets.log`. */
  revset: Schema.String,
  /** Rows start at this log index: 0 replaces the client's rows, otherwise they append. */
  offset: Schema.Number,
  rows: Schema.Array(JjLogRow),
  hasMore: Schema.Boolean,
  remotes: Schema.Array(Schema.String),
});
export type JjPanelReady = typeof JjPanelReady.Type;
export const JjPanelSnapshot = Schema.Union([
  JjPanelReady,
  Schema.Struct({
    status: Schema.Literal("unchanged"),
    cwd: Schema.String,
    operationId: JjOperationId,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    cwd: Schema.String,
    reason: Schema.Literals(["missing-executable", "not-jj-workspace"]),
  }),
]);
export type JjPanelSnapshot = typeof JjPanelSnapshot.Type;
export const JjGetPanelInput = Schema.Struct({
  cwd: Schema.String,
  ...JjLogView.fields,
  /** With the client's row count, the server skips the log read when the operation has not moved. */
  knownOperationId: Schema.optionalKey(JjOperationId),
  loadedCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type JjGetPanelInput = typeof JjGetPanelInput.Type;
export const JjGetRevisionInput = Schema.Struct({ cwd: Schema.String, commitId: JjCommitId });
export type JjGetRevisionInput = typeof JjGetRevisionInput.Type;
const contextFields = {
  cwd: Schema.String,
  workspaceIdentity: JjWorkspaceIdentity,
  expectedOperationId: JjOperationId,
};
// The view shapes the panel page returned with the mutation result.
const mutationFields = { ...contextFields, view: Schema.optionalKey(JjLogView) };
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
  ...contextFields,
  revisionCommitId: JjCommitId,
  /** Diffs from this revision to `revisionCommitId` instead of from its parents. */
  fromCommitId: Schema.optionalKey(JjCommitId),
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
    "invalid-revset",
    "immutable",
    "conflicted",
    "invalid-receipt",
    "concurrent-operation",
    "command-failed",
    "invalid-output",
  ]),
  /** jj's own error line, when one explains the failure. */
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail ? `Jujutsu: ${this.detail}` : `Jujutsu panel: ${this.reason}.`;
  }
}
