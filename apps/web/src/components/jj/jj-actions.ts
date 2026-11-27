import type { ContextMenuItem, JjLogRow, JjRunAction } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

type Row = Pick<
  JjLogRow,
  "commitId" | "changeId" | "parentIds" | "immutable" | "conflict" | "current" | "root" | "empty"
> & { readonly bookmarks?: ReadonlyArray<string> | undefined };

const locked = (row: Row) => Boolean(row.immutable || row.root);

/** Mutable, conflict-free ancestors among the loaded rows, nearest first. */
export const jjSquashTargets = <R extends Row>(input: {
  source: Row;
  rows: ReadonlyArray<R>;
  scope: "parent" | "ancestors";
}): R[] => {
  const byId = new Map(input.rows.map((row) => [row.commitId, row]));
  const seen = new Set([input.source.commitId]);
  const pending = [...input.source.parentIds];
  const result: R[] = [];
  while (pending.length) {
    const id = pending.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (!row) continue;
    if (!locked(row) && !row.conflict) result.push(row);
    if (input.scope === "ancestors") pending.push(...row.parentIds);
  }
  return result;
};

/** True when `descendant` reaches `ancestor` through the loaded parent links. */
const jjIsDescendant = (input: {
  ancestor: string;
  descendant: string;
  rows: ReadonlyArray<Pick<Row, "commitId" | "parentIds">>;
}) => {
  const byId = new Map(input.rows.map((row) => [row.commitId, row]));
  const seen = new Set<string>();
  const pending = [input.descendant];
  while (pending.length) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    if (id === input.ancestor) return true;
    seen.add(id);
    pending.push(...(byId.get(id)?.parentIds ?? []));
  }
  return false;
};

export type JjMenuId =
  | "show-diff"
  | "compare-working-copy"
  | "new"
  | "new-before"
  | "new-after"
  | "edit"
  | "describe"
  | "commit"
  | "duplicate"
  | "abandon"
  | "absorb"
  | "squash-parent"
  | "squash-ancestor"
  | "rebase-onto-selected"
  | "bookmark-set"
  | "bookmark-advance"
  | `bookmark-delete:${string}`
  | "publish"
  | "push"
  | "copy-change-id"
  | "copy-commit-id";

export interface JjMenuContext<R extends Row> {
  readonly row: R;
  readonly rows: ReadonlyArray<R>;
  /** Multi-selection in selection order; may or may not include `row`. */
  readonly selection: ReadonlyArray<R>;
  readonly canWrite: boolean;
  readonly canDiff: boolean;
  readonly canPublish: boolean;
}

/** The selection a bulk action applies to: the selection when `row` is part of it. */
const jjActionTargets = <R extends Row>(context: JjMenuContext<R>): ReadonlyArray<R> =>
  context.selection.some((row) => row.commitId === context.row.commitId) &&
  context.selection.length > 1
    ? context.selection
    : [context.row];

/** jj-view's `webview/context` set, adapted to T3 Code's native/fallback context menu. */
export const jjRevisionMenu = <R extends Row>(
  context: JjMenuContext<R>,
): ContextMenuItem<JjMenuId>[] => {
  const { row, canWrite } = context;
  const targets = jjActionTargets(context);
  const bulk = targets.length > 1;
  const others = context.selection.filter((item) => item.commitId !== row.commitId);
  const anyLocked = targets.some(locked);
  const anyConflict = targets.some((item) => item.conflict);
  const parent = context.rows.find((item) => item.commitId === row.parentIds[0]);
  const items: ContextMenuItem<JjMenuId>[] = [
    { id: "show-diff", label: m(msg("Show diff")), disabled: !context.canDiff },
    ...(row.current
      ? []
      : [
          {
            id: "compare-working-copy" as const,
            label: m(msg("Compare with working copy")),
            disabled: !context.canDiff,
          },
        ]),
    {
      id: "new",
      label: bulk
        ? m(msg("New merge change ({count})", { count: targets.length }))
        : m(msg("New child")),
      separatorBefore: true,
      disabled: !canWrite || (bulk && anyConflict),
    },
    {
      id: "new-before",
      label: bulk
        ? m(
            msg(
              "{count, plural, one {New before {count} revision} other {New before {count} revisions}}",
              { count: targets.length },
            ),
          )
        : m(msg("New before")),
      disabled: !canWrite || anyLocked || anyConflict,
    },
    {
      id: "new-after",
      label: m(msg("New after")),
      disabled: !canWrite || bulk || Boolean(row.conflict),
    },
    {
      id: "edit",
      label: m(msg("Edit", { $context: "verb, makes a revision the working copy" })),
      disabled: !canWrite || bulk || locked(row) || Boolean(row.current),
    },
    { id: "describe", label: m(msg("Describe…")), disabled: !canWrite || bulk || locked(row) },
    ...(row.current
      ? [
          {
            id: "commit" as const,
            label: m(msg("Commit…", { $context: "verb" })),
            disabled: !canWrite || Boolean(row.conflict),
          },
        ]
      : []),
    {
      id: "bookmark-set",
      label: m(msg("Set bookmark…")),
      separatorBefore: true,
      disabled: !canWrite || bulk || Boolean(row.root) || Boolean(row.conflict),
    },
    {
      id: "bookmark-advance",
      label: m(msg("Advance bookmark here…")),
      disabled: !canWrite || bulk || Boolean(row.root) || Boolean(row.conflict),
    },
    ...(row.bookmarks?.length
      ? [
          {
            id: "push" as const,
            label: m(msg("Push bookmarks…")),
            disabled: !canWrite,
          },
          {
            id: "bookmark-delete:" as const,
            label: m(msg("Delete bookmark")),
            disabled: !canWrite,
            children: row.bookmarks.map((name) => ({
              id: `bookmark-delete:${name}` as const,
              label: name,
              destructive: true,
            })),
          },
        ]
      : []),
    {
      id: "publish",
      label: m(msg("Publish (PR/MR)…")),
      disabled: !context.canPublish || bulk || locked(row) || Boolean(row.conflict),
    },
    {
      id: "duplicate",
      label: m(msg("Duplicate", { $context: "verb" })),
      separatorBefore: true,
      disabled: !canWrite || bulk || Boolean(row.conflict) || Boolean(row.root),
    },
    {
      id: "abandon",
      label: bulk
        ? m(
            msg(
              "{count, plural, one {Abandon {count} revision…} other {Abandon {count} revisions…}}",
              { count: targets.length },
            ),
          )
        : m(msg("Abandon…")),
      destructive: true,
      disabled: !canWrite || anyLocked,
    },
    {
      id: "absorb",
      label: m(msg("Absorb into ancestors")),
      disabled: !canWrite || bulk || locked(row) || Boolean(row.conflict) || Boolean(row.empty),
    },
    {
      id: "squash-parent",
      label: m(msg("Squash into parent")),
      disabled:
        !canWrite ||
        bulk ||
        locked(row) ||
        Boolean(row.conflict) ||
        row.parentIds.length !== 1 ||
        Boolean(parent && (locked(parent) || parent.conflict)),
    },
    {
      id: "squash-ancestor",
      label: m(msg("Squash into ancestor…")),
      disabled:
        !canWrite ||
        bulk ||
        locked(row) ||
        Boolean(row.conflict) ||
        jjSquashTargets({ source: row, rows: context.rows, scope: "ancestors" }).length === 0,
    },
    {
      id: "rebase-onto-selected",
      label:
        others.length > 1
          ? m(msg("Rebase onto {count} selected", { count: others.length }))
          : m(msg("Rebase onto selected")),
      separatorBefore: true,
      disabled:
        !canWrite ||
        locked(row) ||
        Boolean(row.conflict) ||
        others.length === 0 ||
        others.length !== context.selection.length ||
        others.some(
          (other) =>
            other.conflict ||
            jjIsDescendant({
              ancestor: row.commitId,
              descendant: other.commitId,
              rows: context.rows,
            }),
        ),
    },
    {
      id: "copy-change-id",
      label: m(msg("Copy change ID")),
      separatorBefore: true,
    },
    { id: "copy-commit-id", label: m(msg("Copy commit ID")) },
  ];
  return items;
};

export type JjDialogRequest<R extends Row> =
  | {
      readonly kind: "confirm";
      readonly title: string;
      readonly description: string;
      readonly confirmLabel: string;
      readonly destructive: boolean;
      readonly action: JjRunAction;
    }
  | { readonly kind: "squash-ancestor"; readonly source: R; readonly paths?: ReadonlyArray<string> }
  | {
      readonly kind: "bookmark";
      readonly mode: "set" | "advance";
      readonly revision: R;
      /** Prefills a new bookmark's name, as the stack view does for a new layer. */
      readonly suggestedName?: string;
    }
  | { readonly kind: "push"; readonly revision: R }
  | { readonly kind: "commit"; readonly revision: R };

export type JjMenuIntent<R extends Row> =
  | { readonly type: "run"; readonly action: JjRunAction; readonly title: string }
  | { readonly type: "dialog"; readonly request: JjDialogRequest<R> }
  | { readonly type: "diff"; readonly commitId: string; readonly fromCommitId?: string }
  | { readonly type: "copy"; readonly value: string; readonly label: string }
  | { readonly type: "describe"; readonly row: R }
  | { readonly type: "publish"; readonly row: R };

const short = (row: Row) => row.changeId.slice(0, 8);

/** Maps a chosen menu entry to what the panel does: run now, confirm first, or navigate. */
export const jjMenuIntent = <R extends Row>(
  id: JjMenuId,
  context: JjMenuContext<R> & { readonly workingCopyCommitId: string },
): JjMenuIntent<R> | null => {
  const { row } = context;
  const targets = jjActionTargets(context);
  const ids = targets.map((item) => item.commitId);
  if (id.startsWith("bookmark-delete:")) {
    const name = id.slice("bookmark-delete:".length);
    if (!name) return null;
    return {
      type: "dialog",
      request: {
        kind: "confirm",
        title: m(msg("Delete bookmark {name}?", { name })),
        description: m(
          msg("Deletes the local bookmark. Publishing the deletion to a remote requires a push."),
        ),
        confirmLabel: m(msg("Delete bookmark")),
        destructive: true,
        action: { type: "bookmark-delete", name },
      },
    };
  }
  switch (id) {
    case "show-diff":
      return { type: "diff", commitId: row.commitId };
    case "compare-working-copy":
      return { type: "diff", commitId: context.workingCopyCommitId, fromCommitId: row.commitId };
    case "new":
      return ids.length > 1
        ? {
            type: "run",
            action: { type: "merge", parentCommitIds: ids },
            title: m(msg("Merge change created")),
          }
        : {
            type: "run",
            action: { type: "new", parentCommitIds: ids },
            title: m(msg("New change created")),
          };
    case "new-before":
    case "new-after":
      return {
        type: "run",
        action: {
          type: "insert",
          revisionCommitIds: id === "new-before" ? ids : [row.commitId],
          position: id === "new-before" ? "before" : "after",
        },
        title: m(msg("New change inserted")),
      };
    case "edit":
      return {
        type: "run",
        action: { type: "edit", revisionCommitId: row.commitId },
        title: m(msg("Editing {revision}", { revision: short(row) })),
      };
    case "describe":
      return { type: "describe", row };
    case "commit":
      return { type: "dialog", request: { kind: "commit", revision: row } };
    case "duplicate":
      return {
        type: "run",
        action: { type: "duplicate", revisionCommitId: row.commitId },
        title: m(msg("Revision duplicated")),
      };
    case "abandon":
      return {
        type: "dialog",
        request: {
          kind: "confirm",
          title:
            ids.length > 1
              ? m(
                  msg(
                    "{count, plural, one {Abandon {count} revision?} other {Abandon {count} revisions?}}",
                    { count: ids.length },
                  ),
                )
              : m(msg("Abandon {revision}?", { revision: short(row) })),
          description: m(
            msg(
              "Abandoned revisions leave history and their descendants are rebased onto their parents. Undo restores them.",
            ),
          ),
          confirmLabel: m(msg("Abandon", { $context: "verb, abandons revisions" })),
          destructive: true,
          action: { type: "abandon", revisionCommitIds: ids },
        },
      };
    case "absorb":
      return {
        type: "run",
        action: { type: "absorb", revisionCommitId: row.commitId },
        title: m(msg("Changes absorbed")),
      };
    case "squash-parent": {
      const parent = row.parentIds[0];
      return parent
        ? {
            type: "run",
            action: {
              type: "squash",
              sourceCommitId: row.commitId,
              destinationCommitId: parent,
              mode: "into",
            },
            title: m(msg("Squashed into parent")),
          }
        : null;
    }
    case "squash-ancestor":
      return { type: "dialog", request: { kind: "squash-ancestor", source: row } };
    case "rebase-onto-selected": {
      const destinations = context.selection
        .filter((item) => item.commitId !== row.commitId)
        .map((item) => item.commitId);
      return destinations.length
        ? {
            type: "run",
            action: {
              type: "rebase",
              revisionCommitId: row.commitId,
              destinationCommitIds: destinations,
              mode: "branch",
            },
            title: m(msg("Rebased onto selection")),
          }
        : null;
    }
    case "bookmark-set":
    case "bookmark-advance":
      return {
        type: "dialog",
        request: {
          kind: "bookmark",
          mode: id === "bookmark-set" ? "set" : "advance",
          revision: row,
        },
      };
    case "push":
      return { type: "dialog", request: { kind: "push", revision: row } };
    case "publish":
      return { type: "publish", row };
    case "copy-change-id":
      return { type: "copy", value: row.changeId, label: m(msg("Change ID")) };
    case "copy-commit-id":
      return { type: "copy", value: row.commitId, label: m(msg("Commit ID")) };
  }
  return null;
};

export type JjDragModifier =
  | "rebase-branch"
  | "rebase-revision"
  | "squash-into"
  | "squash-onto"
  | "duplicate"
  | "merge";

export interface JjDragKeys {
  readonly r: boolean;
  readonly s: boolean;
  readonly shift: boolean;
  readonly d: boolean;
  readonly m: boolean;
}

export const JJ_NO_DRAG_KEYS: JjDragKeys = { r: false, s: false, shift: false, d: false, m: false };

/** jj-view's drag modifiers: Shift+S beats S, single keys beat the default branch rebase. */
export const jjDragModifier = (keys: JjDragKeys): JjDragModifier =>
  keys.s && keys.shift
    ? "squash-onto"
    : keys.r
      ? "rebase-revision"
      : keys.s
        ? "squash-into"
        : keys.d
          ? "duplicate"
          : keys.m
            ? "merge"
            : "rebase-branch";

export const JJ_DRAG_LABELS: Record<JjDragModifier, string> = {
  "rebase-branch": msg("Rebase branch"),
  "rebase-revision": msg("Rebase revision only"),
  "squash-into": msg("Squash into"),
  "squash-onto": msg("Squash onto"),
  duplicate: msg("Duplicate onto"),
  merge: msg("Merge with"),
};

const JJ_DROP_LABELS: Record<JjDragModifier, string> = {
  "rebase-branch": msg("Rebase branch {revision}"),
  "rebase-revision": msg("Rebase revision only {revision}"),
  "squash-into": msg("Squash into {revision}"),
  "squash-onto": msg("Squash onto {revision}"),
  duplicate: msg("Duplicate onto {revision}"),
  merge: msg("Merge with {revision}"),
};

export type JjDragSource =
  | { readonly kind: "revision"; readonly commitId: string }
  | { readonly kind: "bookmark"; readonly name: string; readonly commitId: string };

export type JjDropResult =
  | { readonly ok: true; readonly action: JjRunAction; readonly label: string }
  | { readonly ok: false; readonly reason: string };

export const jjDropAction = (
  input: {
    source: JjDragSource;
    targetCommitId: string;
    modifier: JjDragModifier;
    rows: ReadonlyArray<Row>;
  },
  resolve: MessageResolver = m,
): JjDropResult => {
  const source = input.rows.find((row) => row.commitId === input.source.commitId);
  const target = input.rows.find((row) => row.commitId === input.targetCommitId);
  if (!source || !target) return { ok: false, reason: resolve(msg("Drop on a listed revision")) };
  if (input.source.kind === "bookmark") {
    if (target.commitId === source.commitId)
      return { ok: false, reason: resolve(msg("Already here")) };
    if (target.root || target.conflict)
      return {
        ok: false,
        reason: resolve(msg("Bookmarks need a conflict-free, non-root revision")),
      };
    return {
      ok: true,
      action: { type: "bookmark-set", name: input.source.name, revisionCommitId: target.commitId },
      label: resolve(
        msg("Move {name} to {revision}", { name: input.source.name, revision: short(target) }),
      ),
    };
  }
  if (target.commitId === source.commitId)
    return { ok: false, reason: resolve(msg("Drop on another revision")) };
  if (target.conflict || (source.conflict && input.modifier !== "rebase-branch"))
    return { ok: false, reason: resolve(msg("Resolve conflicts first")) };
  const moves = ["rebase-branch", "rebase-revision", "squash-into", "squash-onto"];
  if (locked(source) && moves.includes(input.modifier))
    return { ok: false, reason: resolve(msg("Immutable revisions can't be rewritten")) };
  if (source.conflict) return { ok: false, reason: resolve(msg("Resolve conflicts first")) };
  const label = resolve(JJ_DROP_LABELS[input.modifier], { revision: short(target) });
  switch (input.modifier) {
    case "rebase-branch":
    case "rebase-revision":
      if (
        input.modifier === "rebase-branch" &&
        jjIsDescendant({ ancestor: source.commitId, descendant: target.commitId, rows: input.rows })
      )
        return { ok: false, reason: resolve(msg("Can't rebase a branch onto its own descendant")) };
      return {
        ok: true,
        action: {
          type: "rebase",
          revisionCommitId: source.commitId,
          destinationCommitIds: [target.commitId],
          mode: input.modifier === "rebase-branch" ? "branch" : "revision",
        },
        label,
      };
    case "squash-into":
    case "squash-onto":
      if (input.modifier === "squash-into" && locked(target))
        return { ok: false, reason: resolve(msg("Can't squash into an immutable revision")) };
      return {
        ok: true,
        action: {
          type: "squash",
          sourceCommitId: source.commitId,
          destinationCommitId: target.commitId,
          mode: input.modifier === "squash-into" ? "into" : "onto",
        },
        label,
      };
    case "duplicate":
      return {
        ok: true,
        action: {
          type: "duplicate",
          revisionCommitId: source.commitId,
          destinationCommitIds: [target.commitId],
        },
        label,
      };
    case "merge":
      return {
        ok: true,
        action: { type: "merge", parentCommitIds: [source.commitId, target.commitId] },
        label,
      };
  }
};
