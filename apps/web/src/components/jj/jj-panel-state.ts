import { JjRunAction, type JjRunActionInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";

export interface DescriptionDraft {
  readonly text: string;
  readonly baseDescription: string;
  readonly baseCommitId: string;
}

export const descriptionDraftIsStale = (input: {
  draft: DescriptionDraft;
  revision: { commitId: string; description: string };
}) =>
  input.draft.baseCommitId !== input.revision.commitId ||
  input.draft.baseDescription !== input.revision.description;

export const reconcileDescriptionDrafts = (input: {
  drafts: Readonly<Record<string, DescriptionDraft>>;
  revisions: ReadonlyArray<{ changeId: string; commitId: string; description: string }>;
}): Record<string, DescriptionDraft> => {
  const next = { ...input.drafts };
  for (const revision of input.revisions) {
    const draft = next[revision.changeId];
    if (!draft || draft.text === draft.baseDescription) {
      next[revision.changeId] = {
        text: revision.description,
        baseDescription: revision.description,
        baseCommitId: revision.commitId,
      };
    }
  }
  return next;
};

export const jjPanelRequestError = (message: string) =>
  /unknown (?:method|request|rpc)|not (?:found|implemented)|unsupported.*(?:method|rpc)|method.*(?:unknown|not found|unsupported)|no handler/i.test(
    message,
  )
    ? "This environment's T3 Code server does not support the Jujutsu panel. Update that server to use it."
    : message;

export const formatJjPanelError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "The Jujutsu request failed.";
  return jjPanelRequestError(message);
};

export type JjPanelActionKind =
  | "new"
  | "commit"
  | "edit"
  | "insert-before"
  | "insert-after"
  | "squash-into"
  | "squash-onto"
  | "absorb"
  | "rebase-revision"
  | "rebase-branch"
  | "duplicate"
  | "merge"
  | "abandon"
  | "restore"
  | "undo"
  | "redo"
  | "bookmark-set"
  | "bookmark-delete"
  | "bookmark-advance"
  | "push";

export const jjActionLabels: Record<JjPanelActionKind, string> = {
  new: "New empty child",
  commit: "Commit message, then new",
  edit: "Make working copy",
  "insert-before": "Insert before",
  "insert-after": "Insert after",
  "squash-into": "Squash into revision",
  "squash-onto": "Squash onto new child",
  absorb: "Absorb changes",
  "rebase-revision": "Rebase revision",
  "rebase-branch": "Rebase branch",
  duplicate: "Duplicate revision",
  merge: "Merge selected parents",
  abandon: "Abandon revisions",
  restore: "Restore files",
  undo: "Undo operation",
  redo: "Redo operation",
  "bookmark-set": "Set / move bookmark",
  "bookmark-delete": "Delete bookmark",
  "bookmark-advance": "Advance bookmark",
  push: "Push bookmarks",
};

type TargetRevision = { commitId: string; immutable: boolean; conflict: boolean };

export const jjSquashTargets = <
  R extends TargetRevision & { parentIds: ReadonlyArray<string> },
>(input: {
  source: R;
  revisions: ReadonlyArray<R>;
  scope: "parent" | "ancestors";
}) => {
  const byId = new Map(input.revisions.map((revision) => [revision.commitId, revision]));
  const seen = new Set([input.source.commitId]);
  const pending = [...input.source.parentIds];
  const result: R[] = [];
  while (pending.length) {
    const id = pending.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const revision = byId.get(id);
    if (!revision) continue;
    if (!revision.immutable && !revision.conflict) result.push(revision);
    if (input.scope === "ancestors") pending.push(...revision.parentIds);
  }
  return result;
};

export const jjFileActionPaths = (input: { path: string; selectedPaths: ReadonlyArray<string> }) =>
  input.selectedPaths.includes(input.path) ? [...input.selectedPaths] : [input.path];

export const selectableJjTargets = <R extends TargetRevision>(input: {
  kind: JjPanelActionKind;
  sourceCommitId: string;
  revisions: ReadonlyArray<R>;
}) =>
  input.revisions.filter((revision) => {
    if (
      ["squash-into", "squash-onto", "rebase-revision", "rebase-branch"].includes(input.kind) &&
      revision.commitId === input.sourceCommitId
    )
      return false;
    if (input.kind === "squash-into") return !revision.immutable && !revision.conflict;
    if (
      ["squash-onto", "rebase-revision", "rebase-branch", "duplicate", "merge"].includes(input.kind)
    )
      return !revision.conflict;
    return true;
  });

export const visibleJjRevisions = <
  R extends { commitId: string; parentIds: ReadonlyArray<string> },
>(input: {
  revisions: ReadonlyArray<R>;
  workingCopyCommitId: string;
}): R[] => {
  const current = input.revisions.find(
    (revision) => revision.commitId === input.workingCopyCommitId,
  );
  if (!current) return [];
  const byId = new Map(input.revisions.map((revision) => [revision.commitId, revision]));
  const result = [current];
  const seen = new Set([current.commitId]);
  const pending = [...current.parentIds];
  while (pending.length && result.length < 11) {
    const id = pending.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const revision = byId.get(id);
    if (!revision) continue;
    result.push(revision);
    pending.push(...revision.parentIds);
  }
  return result;
};

export const otherLoadedJjRevisions = <R extends { commitId: string }>(input: {
  revisions: ReadonlyArray<R>;
  visibleRevisions: ReadonlyArray<{ commitId: string }>;
}): R[] => {
  const visibleIds = new Set(input.visibleRevisions.map((revision) => revision.commitId));
  return input.revisions.filter((revision) => !visibleIds.has(revision.commitId));
};

export const reconcileJjSelection = (input: {
  selectedCommitIds: ReadonlyArray<string>;
  revisions: ReadonlyArray<{ commitId: string }>;
}) =>
  input.selectedCommitIds.filter((id) =>
    input.revisions.some((revision) => revision.commitId === id),
  );

export const jjActionContextIsCurrent = (input: {
  captured: { operationId: string; workspaceIdentity: unknown };
  current: { operationId: string; workspaceIdentity: unknown } | null;
}) =>
  Boolean(
    input.current &&
    input.captured.operationId === input.current.operationId &&
    JSON.stringify(input.captured.workspaceIdentity) ===
      JSON.stringify(input.current.workspaceIdentity),
  );

const isJjRunAction = Schema.is(JjRunAction);

export interface JjActionFields {
  readonly targetCommitIds: string[];
  readonly paths: string[];
  readonly allFiles: boolean;
  readonly description: string;
  readonly replaceMessage: boolean;
  readonly bookmarkName: string;
  readonly bookmarkNames: string[];
  readonly remote: string;
}

export const buildJjPanelAction = (input: {
  kind: JjPanelActionKind;
  sourceCommitId: string;
  selectedCommitIds: ReadonlyArray<string>;
  fields: JjActionFields;
  revisions: ReadonlyArray<TargetRevision & { files?: ReadonlyArray<{ path: string }> }>;
  workingCopyCommitId: string;
  filesTruncated?: boolean;
}): JjRunActionInput["action"] | null => {
  const fields = input.fields;
  const source = input.revisions.find((revision) => revision.commitId === input.sourceCommitId);
  const selected = input.selectedCommitIds.length
    ? [...input.selectedCommitIds]
    : [input.sourceCommitId];
  const targets = selectableJjTargets(input);
  if (fields.targetCommitIds.some((id) => !targets.some((revision) => revision.commitId === id)))
    return null;
  const paths = fields.allFiles ? undefined : fields.paths;
  if (paths?.some((path) => !source?.files?.some((file) => file.path === path))) return null;
  if (
    ["squash-into", "squash-onto", "absorb", "restore"].includes(input.kind) &&
    !fields.allFiles &&
    !fields.paths.length
  )
    return null;
  if (!["undo", "redo", "bookmark-delete", "push"].includes(input.kind) && !source) return null;
  if (
    [
      "commit",
      "edit",
      "squash-into",
      "squash-onto",
      "absorb",
      "rebase-revision",
      "rebase-branch",
      "restore",
    ].includes(input.kind) &&
    source?.immutable
  )
    return null;
  if (
    [
      "commit",
      "squash-into",
      "squash-onto",
      "absorb",
      "rebase-revision",
      "rebase-branch",
      "duplicate",
    ].includes(input.kind) &&
    source?.conflict
  )
    return null;
  const targetId = fields.targetCommitIds[0];
  const bookmarkName = fields.bookmarkName.trim();
  const generate = (): JjRunActionInput["action"] | null => {
    switch (input.kind) {
      case "new":
        return fields.targetCommitIds.length
          ? { type: "new", parentCommitIds: fields.targetCommitIds }
          : null;
      case "commit":
        return input.sourceCommitId === input.workingCopyCommitId
          ? { type: "commit", description: fields.description }
          : null;
      case "edit":
        return { type: "edit", revisionCommitId: input.sourceCommitId };
      case "insert-before":
      case "insert-after":
        return selected.every((id) =>
          input.revisions.some(
            (revision) =>
              revision.commitId === id &&
              !revision.conflict &&
              (input.kind === "insert-after" || !revision.immutable),
          ),
        )
          ? {
              type: "insert",
              revisionCommitIds: selected,
              position: input.kind === "insert-before" ? "before" : "after",
            }
          : null;
      case "squash-into":
      case "squash-onto":
        return targetId && fields.targetCommitIds.length === 1
          ? {
              type: "squash",
              sourceCommitId: input.sourceCommitId,
              destinationCommitId: targetId,
              mode: input.kind === "squash-into" ? "into" : "onto",
              ...(paths ? { paths } : {}),
              ...(fields.replaceMessage
                ? { messagePolicy: { type: "replace", description: fields.description } }
                : {}),
            }
          : null;
      case "absorb":
        return {
          type: "absorb",
          revisionCommitId: input.sourceCommitId,
          ...(paths ? { paths } : {}),
        };
      case "rebase-revision":
      case "rebase-branch":
        return fields.targetCommitIds.length
          ? {
              type: "rebase",
              revisionCommitId: input.sourceCommitId,
              destinationCommitIds: fields.targetCommitIds,
              mode: input.kind === "rebase-revision" ? "revision" : "branch",
            }
          : null;
      case "duplicate":
        return {
          type: "duplicate",
          revisionCommitId: input.sourceCommitId,
          ...(fields.targetCommitIds.length
            ? { destinationCommitIds: fields.targetCommitIds }
            : {}),
        };
      case "merge":
        return fields.targetCommitIds.length > 1
          ? { type: "merge", parentCommitIds: fields.targetCommitIds }
          : null;
      case "abandon":
        return selected.every((id) =>
          input.revisions.some((revision) => revision.commitId === id && !revision.immutable),
        )
          ? { type: "abandon", revisionCommitIds: selected }
          : null;
      case "restore":
        return fields.allFiles && input.filesTruncated
          ? null
          : {
              type: "restore",
              revisionCommitId: input.sourceCommitId,
              paths: paths ?? source?.files?.map((file) => file.path) ?? [],
            };
      case "undo":
        return { type: "undo" };
      case "redo":
        return { type: "redo" };
      case "bookmark-set":
        return bookmarkName
          ? { type: "bookmark-set", name: bookmarkName, revisionCommitId: input.sourceCommitId }
          : null;
      case "bookmark-delete":
        return bookmarkName ? { type: "bookmark-delete", name: bookmarkName } : null;
      case "bookmark-advance":
        return bookmarkName
          ? { type: "bookmark-advance", name: bookmarkName, revisionCommitId: input.sourceCommitId }
          : null;
      case "push": {
        const bookmarkNames = fields.bookmarkNames.map((name) => name.trim()).filter(Boolean);
        return bookmarkNames.length && fields.remote.trim()
          ? { type: "push", bookmarkNames, remote: fields.remote.trim() }
          : null;
      }
    }
  };
  const action = generate();
  return action && isJjRunAction(action) ? action : null;
};
