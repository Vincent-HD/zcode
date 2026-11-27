import type { JjLogRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  jjGitActionBlocker,
  jjGitActionsState,
  jjNextBookmarkName,
  jjQuickAction,
} from "./jj-git-actions";

const row = (id: string, fields: Partial<JjLogRow> = {}): JjLogRow => ({
  commitId: id.repeat(40).slice(0, 40),
  changeId: "k".repeat(32),
  parentIds: [],
  summary: "",
  author: { name: "", email: "", timestamp: "" },
  changePrefixLength: 4,
  commitPrefixLength: 4,
  ...fields,
});

const trunk = (bookmarks: ReadonlyArray<string>) =>
  row("1", {
    immutable: true,
    summary: "main",
    bookmarks: ["main", ...bookmarks],
    remoteBookmarks: ["main@origin"],
  });

const state = (rows: ReadonlyArray<JjLogRow>) =>
  jjGitActionsState({ rows, workingCopyCommitId: rows[0]!.commitId, remotes: ["origin"] });

describe("jjGitActionsState", () => {
  it("moves a worktree bookmark left on trunk up to the committed work", () => {
    const work = row("b", { summary: "fix: thing" });
    const result = state([row("a", { empty: true }), work, trunk(["t3/x"])]);
    expect(result).toMatchObject({
      canCommit: false,
      target: work,
      bookmark: "t3/x",
      needsMove: true,
      pushed: false,
      baseBookmark: "main",
      remote: "origin",
    });
    expect(
      jjQuickAction({ state: result, canCreatePullRequest: true, hasPullRequest: false }),
    ).toBe("push");
  });

  it("commits first, then pushes, then offers the pull request", () => {
    const dirty = state([row("a"), row("b", { summary: "fix", bookmarks: ["t3/x"] }), trunk([])]);
    expect(dirty.target?.summary).toBe("fix");
    expect(jjQuickAction({ state: dirty, canCreatePullRequest: true, hasPullRequest: false })).toBe(
      "commit",
    );

    const pushed = state([
      row("a", { empty: true }),
      row("b", { summary: "fix", bookmarks: ["t3/x"], remoteBookmarks: ["t3/x@origin"] }),
      trunk([]),
    ]);
    expect(pushed).toMatchObject({ needsMove: false, pushed: true });
    expect(jjGitActionBlocker(pushed, "push")).toBe("pushed");
    expect(
      jjQuickAction({ state: pushed, canCreatePullRequest: true, hasPullRequest: false }),
    ).toBe("create-pr");
    expect(
      jjQuickAction({ state: pushed, canCreatePullRequest: false, hasPullRequest: false }),
    ).toBeNull();
    expect(jjQuickAction({ state: pushed, canCreatePullRequest: true, hasPullRequest: true })).toBe(
      "view-pr",
    );
    // Unpushed commits still push first, which also updates the open pull request.
    expect(jjQuickAction({ state: dirty, canCreatePullRequest: true, hasPullRequest: true })).toBe(
      "commit",
    );
  });

  it("publishes a described working copy and skips undescribed changes", () => {
    expect(state([row("a", { summary: "wip" }), trunk(["t3/x"])]).target?.summary).toBe("wip");
    const undescribed = state([row("a"), trunk(["t3/x"])]);
    expect(undescribed.target).toBeNull();
    expect(jjGitActionBlocker(undescribed, "push")).toBe("no-target");
  });

  it("finds trunk's bookmark when jj hides its in-sync remote", () => {
    const synced = row("1", { immutable: true, summary: "main", bookmarks: ["main", "t3/x"] });
    const result = state([row("a", { empty: true }), row("b", { summary: "fix" }), synced]);
    expect(result).toMatchObject({ baseBookmark: "main", bookmark: "t3/x", needsMove: true });

    const work = row("b", { summary: "fix", bookmarks: ["t3/x"] });
    const rows = [row("a", { empty: true }), work, trunk([])];
    const read = (commitId: string | null) =>
      jjGitActionsState({
        rows,
        workingCopyCommitId: rows[0]!.commitId,
        remotes: ["origin"],
        remoteHead: { bookmark: "t3/x", commitId },
      }).pushed;
    expect(read(work.commitId)).toBe(true);
    expect(read(null)).toBe(false);
  });

  it("never treats trunk's own bookmark as the work's", () => {
    const result = state([row("a", { empty: true }), row("b", { summary: "fix" }), trunk([])]);
    expect(result.bookmark).toBeNull();
    expect(jjGitActionBlocker(result, "push")).toBe("no-bookmark");
  });

  it("keeps a stack's lower bookmarks and moves the worktree's onto the newest layer", () => {
    const top = row("c", { summary: "feat: ui" });
    const middle = row("b", { summary: "feat: api", bookmarks: ["t3/x-2"] });
    const bottom = row("d", { summary: "feat: model", bookmarks: ["t3/x-3"] });
    const result = state([row("a", { empty: true }), top, middle, bottom, trunk(["t3/x"])]);
    expect(result).toMatchObject({ bookmark: "t3/x", needsMove: true, target: top });
    expect(result.stack.map((entry) => [entry.row.summary, entry.bookmark])).toEqual([
      ["feat: model", "t3/x-3"],
      ["feat: api", "t3/x-2"],
      ["feat: ui", "t3/x"],
    ]);
    expect(result.stackBookmarks).toEqual(["t3/x-3", "t3/x-2", "t3/x"]);
    const quick = (stackPublished: boolean) =>
      jjQuickAction({
        state: result,
        canCreatePullRequest: true,
        hasPullRequest: false,
        stackPublished,
      });
    expect(quick(false)).toBe("publish-stack");
    expect(quick(true)).toBe("push");
  });

  it("extends a single bookmark over new commits instead of stacking", () => {
    const result = state([
      row("a", { summary: "fix: second" }),
      row("b", { summary: "fix: first", bookmarks: ["t3/x"] }),
      trunk([]),
    ]);
    expect(result).toMatchObject({ bookmark: "t3/x", needsMove: true, stackBookmarks: ["t3/x"] });
    expect(jjGitActionBlocker(result, "publish-stack")).toBe("no-stack");
  });

  it("names a new layer after the work's bookmark", () => {
    expect(jjNextBookmarkName({ base: "t3/x", taken: ["t3/x"] })).toBe("t3/x-2");
    expect(jjNextBookmarkName({ base: "t3/x-2", taken: ["t3/x", "t3/x-2", "t3/x-3"] })).toBe(
      "t3/x-4",
    );
  });
});
