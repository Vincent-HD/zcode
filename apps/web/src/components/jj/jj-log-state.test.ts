import type { JjLogRow, JjPanelReady } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { jjRefreshInput, mergeJjSnapshot } from "./jj-log-state";

const row = (letter: string): JjLogRow => ({
  commitId: letter.repeat(40),
  changeId: "k".repeat(32),
  parentIds: [],
  summary: letter,
  author: { name: "A", email: "a@example.invalid", timestamp: "2026-01-01T00:00:00Z" },
  changePrefixLength: 1,
  commitPrefixLength: 1,
});
const panel = (input: {
  operation: string;
  offset?: number;
  rows: ReadonlyArray<JjLogRow>;
  hasMore?: boolean;
}): JjPanelReady => ({
  status: "ready",
  cwd: "/repo",
  workspaceIdentity: { workspaceRoot: "/repo", repositoryPath: "/repo/.jj/repo", workspaceId: "w" },
  operationId: input.operation.repeat(128),
  workingCopyCommitId: "a".repeat(40),
  revset: "builtin_log()",
  offset: input.offset ?? 0,
  rows: input.rows,
  hasMore: input.hasMore ?? false,
  remotes: [],
});

describe("Jujutsu log refreshes", () => {
  it("asks the server to skip unchanged work, including a fully loaded short log", () => {
    const view = { revset: undefined, limit: 100 };
    expect(jjRefreshInput({ cwd: "/repo", view, current: null })).toEqual({
      cwd: "/repo",
      limit: 100,
    });
    const held = panel({ operation: "1", rows: [row("a")] });
    expect(jjRefreshInput({ cwd: "/repo", view, current: held })).toMatchObject({
      knownOperationId: held.operationId,
      loadedCount: 100,
    });
    expect(
      jjRefreshInput({
        cwd: "/repo",
        view: { revset: "all()", limit: 200 },
        current: { ...held, hasMore: true },
      }),
    ).toMatchObject({ revset: "all()", limit: 200, loadedCount: 1 });
  });

  it("keeps rows for an unchanged operation and reloads when it moved", () => {
    const held = panel({ operation: "1", rows: [row("a")] });
    expect(
      mergeJjSnapshot(held, { status: "unchanged", cwd: "/repo", operationId: held.operationId }),
    ).toEqual({ type: "keep" });
    expect(
      mergeJjSnapshot(held, { status: "unchanged", cwd: "/repo", operationId: "2".repeat(128) }),
    ).toEqual({ type: "reload" });
  });

  it("appends a page only when it continues the held rows at the same operation", () => {
    const held = panel({ operation: "1", rows: [row("a"), row("b")], hasMore: true });
    const page = panel({ operation: "1", offset: 2, rows: [row("c")] });
    const merged = mergeJjSnapshot(held, page);
    expect(merged.type === "replace" && merged.panel.rows.map((value) => value.summary)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(merged.type === "replace" && merged.panel.offset).toBe(0);
    expect(mergeJjSnapshot(held, { ...page, offset: 1 })).toEqual({ type: "reload" });
    expect(mergeJjSnapshot(held, panel({ operation: "2", offset: 2, rows: [row("c")] }))).toEqual({
      type: "reload",
    });
    expect(mergeJjSnapshot(held, panel({ operation: "2", rows: [row("z")] })).type).toBe("replace");
  });
});
