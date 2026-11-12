import type { JjLogRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  JJ_NO_DRAG_KEYS,
  jjDragModifier,
  jjDropAction,
  jjMenuIntent,
  jjRevisionMenu,
  type JjMenuContext,
} from "./jj-actions";

const id = (letter: string) => letter.repeat(40);
const row = (
  letter: string,
  parents: ReadonlyArray<string>,
  extra: Partial<JjLogRow> = {},
): JjLogRow => ({
  commitId: id(letter),
  changeId: letter === "w" ? "w".repeat(32) : `${letter}${"k".repeat(31)}`,
  parentIds: parents.map(id),
  summary: letter,
  author: { name: "A", email: "a@example.invalid", timestamp: "2026-01-01T00:00:00Z" },
  changePrefixLength: 1,
  commitPrefixLength: 1,
  ...extra,
});
// w (working copy) -> b -> a -> m (immutable trunk); s is a sibling branch on m.
const w = row("w", ["b"], { current: true, empty: true, bookmarks: ["topic"] });
const b = row("b", ["a"]);
const a = row("a", ["m"]);
const s = row("s", ["m"]);
const m = row("m", [], { immutable: true, bookmarks: ["main"] });
const rows = [w, b, a, s, m];
const context = (target: JjLogRow, selection: ReadonlyArray<JjLogRow> = []) =>
  ({
    row: target,
    rows,
    selection,
    canWrite: true,
    canDiff: true,
    canPublish: true,
    workingCopyCommitId: w.commitId,
  }) satisfies JjMenuContext<JjLogRow> & { workingCopyCommitId: string };
const item = (target: JjLogRow, menuId: string, selection: ReadonlyArray<JjLogRow> = []) =>
  jjRevisionMenu(context(target, selection)).find((entry) => entry.id === menuId);

describe("Jujutsu revision context menu", () => {
  it("disables rewrites of immutable revisions but keeps new children and copies", () => {
    for (const menuId of ["edit", "abandon", "squash-parent", "absorb", "describe", "new-before"])
      expect(item(m, menuId)?.disabled).toBe(true);
    for (const menuId of [
      "new",
      "new-after",
      "copy-change-id",
      "show-diff",
      "compare-working-copy",
    ])
      expect(item(m, menuId)?.disabled).toBeFalsy();
  });

  it("offers commit only on the working copy and compare only elsewhere", () => {
    expect(item(w, "commit")).toBeDefined();
    expect(item(w, "compare-working-copy")).toBeUndefined();
    expect(item(b, "commit")).toBeUndefined();
    expect(item(w, "bookmark-delete:")?.children?.map((child) => child.id)).toEqual([
      "bookmark-delete:topic",
    ]);
  });

  it("applies bulk labels when the clicked row is part of the selection", () => {
    expect(item(b, "abandon", [b, a])?.label).toBe("Abandon 2 revisions…");
    expect(item(b, "new", [b, a])?.label).toBe("New merge change (2)");
    expect(item(b, "abandon", [a, s])?.label).toBe("Abandon…");
    expect(item(b, "edit", [b, a])?.disabled).toBe(true);
  });

  it("allows rebasing onto a selection that is not a descendant", () => {
    expect(item(s, "rebase-onto-selected")?.disabled).toBe(true);
    expect(item(s, "rebase-onto-selected", [b])?.disabled).toBeFalsy();
    expect(item(a, "rebase-onto-selected", [w])?.disabled).toBe(true);
    expect(item(m, "rebase-onto-selected", [s])?.disabled).toBe(true);
  });

  it("maps menu entries to jj actions", () => {
    expect(jjMenuIntent("new", context(b, [b, a]))).toMatchObject({
      type: "run",
      action: { type: "merge", parentCommitIds: [b.commitId, a.commitId] },
    });
    expect(jjMenuIntent("new-before", context(b))).toMatchObject({
      action: { type: "insert", revisionCommitIds: [b.commitId], position: "before" },
    });
    expect(jjMenuIntent("squash-parent", context(b))).toMatchObject({
      action: {
        type: "squash",
        sourceCommitId: b.commitId,
        destinationCommitId: a.commitId,
        mode: "into",
      },
    });
    expect(jjMenuIntent("rebase-onto-selected", context(s, [b]))).toMatchObject({
      action: {
        type: "rebase",
        revisionCommitId: s.commitId,
        destinationCommitIds: [b.commitId],
        mode: "branch",
      },
    });
    expect(jjMenuIntent("abandon", context(b, [b, a]))).toMatchObject({
      type: "dialog",
      request: {
        kind: "confirm",
        destructive: true,
        action: { type: "abandon", revisionCommitIds: [b.commitId, a.commitId] },
      },
    });
    expect(jjMenuIntent("bookmark-delete:topic", context(w))).toMatchObject({
      request: { kind: "confirm", action: { type: "bookmark-delete", name: "topic" } },
    });
    expect(jjMenuIntent("compare-working-copy", context(a))).toEqual({
      type: "diff",
      commitId: w.commitId,
      fromCommitId: a.commitId,
    });
    expect(jjMenuIntent("copy-commit-id", context(a))).toEqual({
      type: "copy",
      value: a.commitId,
      label: "Commit ID",
    });
  });
});

describe("Jujutsu drag and drop", () => {
  it("resolves modifier keys with jj-view's precedence", () => {
    expect(jjDragModifier(JJ_NO_DRAG_KEYS)).toBe("rebase-branch");
    expect(jjDragModifier({ ...JJ_NO_DRAG_KEYS, r: true })).toBe("rebase-revision");
    expect(jjDragModifier({ ...JJ_NO_DRAG_KEYS, s: true })).toBe("squash-into");
    expect(jjDragModifier({ ...JJ_NO_DRAG_KEYS, s: true, shift: true, r: true })).toBe(
      "squash-onto",
    );
    expect(jjDragModifier({ ...JJ_NO_DRAG_KEYS, d: true })).toBe("duplicate");
    expect(jjDragModifier({ ...JJ_NO_DRAG_KEYS, m: true })).toBe("merge");
  });

  const drop = (
    source: JjLogRow,
    target: JjLogRow,
    modifier: Parameters<typeof jjDropAction>[0]["modifier"],
  ) =>
    jjDropAction({
      source: { kind: "revision", commitId: source.commitId },
      targetCommitId: target.commitId,
      modifier,
      rows,
    });

  it("maps each drop operation to its jj action", () => {
    expect(drop(b, s, "rebase-branch")).toMatchObject({
      ok: true,
      action: {
        type: "rebase",
        revisionCommitId: b.commitId,
        destinationCommitIds: [s.commitId],
        mode: "branch",
      },
    });
    expect(drop(b, s, "rebase-revision")).toMatchObject({ action: { mode: "revision" } });
    expect(drop(b, s, "squash-into")).toMatchObject({ action: { type: "squash", mode: "into" } });
    expect(drop(b, m, "squash-onto")).toMatchObject({ action: { type: "squash", mode: "onto" } });
    expect(drop(m, s, "duplicate")).toMatchObject({
      action: {
        type: "duplicate",
        revisionCommitId: m.commitId,
        destinationCommitIds: [s.commitId],
      },
    });
    expect(drop(b, s, "merge")).toMatchObject({
      action: { type: "merge", parentCommitIds: [b.commitId, s.commitId] },
    });
  });

  it("refuses drops jj would reject", () => {
    expect(drop(b, b, "rebase-branch")).toMatchObject({ ok: false });
    expect(drop(a, w, "rebase-branch")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("descendant"),
    });
    expect(drop(m, s, "rebase-branch")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Immutable"),
    });
    expect(drop(b, m, "squash-into")).toMatchObject({ ok: false });
  });

  it("moves a dragged bookmark", () => {
    expect(
      jjDropAction({
        source: { kind: "bookmark", name: "topic", commitId: w.commitId },
        targetCommitId: a.commitId,
        modifier: "rebase-branch",
        rows,
      }),
    ).toMatchObject({
      ok: true,
      action: { type: "bookmark-set", name: "topic", revisionCommitId: a.commitId },
    });
  });
});
