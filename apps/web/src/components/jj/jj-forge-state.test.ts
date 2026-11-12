import { describe, expect, it } from "@effect/vitest";
import type { JjLogRow } from "@t3tools/contracts";
import { jjForgeFailureMessage, selectJjForgeChain } from "./jj-forge-state";

const base = "a".repeat(40);
const first = "b".repeat(40);
const top = "c".repeat(40);
const row = (input: {
  commitId: string;
  parentIds: ReadonlyArray<string>;
  changeId: string;
  summary: string;
  bookmarks: ReadonlyArray<string>;
  immutable?: boolean;
}): JjLogRow => ({
  ...input,
  author: { name: "A", email: "a@example.invalid", timestamp: "2026-01-01T00:00:00Z" },
  changePrefixLength: 1,
  commitPrefixLength: 1,
});
const rows: ReadonlyArray<JjLogRow> = [
  row({
    commitId: top,
    parentIds: [first],
    changeId: "k".repeat(32),
    summary: "top",
    bookmarks: ["top", "alternate"],
  }),
  row({
    commitId: first,
    parentIds: [base],
    changeId: "l".repeat(32),
    summary: "first",
    bookmarks: ["first"],
  }),
  row({
    commitId: base,
    parentIds: ["0".repeat(40)],
    changeId: "m".repeat(32),
    summary: "base",
    bookmarks: ["main"],
    immutable: true,
  }),
];
const panel = { rows };
const input = {
  panel,
  targetCommitId: top,
  mode: "linear-stack",
  bookmarks: {},
} satisfies Parameters<typeof selectJjForgeChain>[0];

describe("JJ forge selection", () => {
  it("walks ancestors bottom to top, stopping before immutable base", () => {
    expect(selectJjForgeChain(input)).toEqual({
      selections: [
        { commitId: first, bookmark: "first" },
        { commitId: top, bookmark: "top" },
      ],
      issue: null,
    });
  });
  it("keeps the explicitly chosen bookmark and limits single mode to its target", () => {
    expect(
      selectJjForgeChain({ ...input, mode: "single", bookmarks: { [top]: "alternate" } }),
    ).toEqual({ selections: [{ commitId: top, bookmark: "alternate" }], issue: null });
  });
  it("does not silently publish a truncated chain", () => {
    expect(selectJjForgeChain({ ...input, panel: { rows: rows.slice(0, 2) } }).issue).toContain(
      "outside the loaded revisions",
    );
  });
  it("rejects merge ancestry and missing bookmark", () => {
    expect(
      selectJjForgeChain({
        ...input,
        panel: {
          rows: rows.map((revision) =>
            revision.commitId === first ? { ...revision, parentIds: [base, top] } : revision,
          ),
        },
      }).issue,
    ).toContain("without merges");
    expect(
      selectJjForgeChain({
        ...input,
        panel: {
          rows: rows.map((revision) =>
            revision.commitId === first ? { ...revision, bookmarks: [] } : revision,
          ),
        },
      }).issue,
    ).toContain("local bookmark");
  });
  it("shows domain failures without exposing provider or process output", () => {
    expect(jjForgeFailureMessage({ reason: "retarget-required", cause: "secret" })).toContain(
      "Retarget",
    );
    expect(jjForgeFailureMessage(new Error("secret"))).not.toContain("secret");
  });
});
