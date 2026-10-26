import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { JjPanelReady } from "@t3tools/contracts";
import { jjForgeFailureMessage, selectJjForgeChain } from "./jj-forge-state";

const base = "a".repeat(40);
const first = "b".repeat(40);
const top = "c".repeat(40);
const panel = Schema.decodeSync(JjPanelReady)({
  status: "ready",
  cwd: "/repo",
  workspaceIdentity: {
    workspaceRoot: "/repo",
    repositoryPath: "/repo/.jj/repo",
    workspaceId: "workspace",
  },
  operationId: "d".repeat(128),
  workingCopyCommitId: top,
  filesTruncated: false,
  revisions: [
    {
      commitId: top,
      parentIds: [first],
      changeId: "k".repeat(32),
      description: "top",
      bookmarks: ["top", "alternate"],
      immutable: false,
      conflict: false,
      empty: false,
      current: true,
      files: [],
    },
    {
      commitId: first,
      parentIds: [base],
      changeId: "l".repeat(32),
      description: "first",
      bookmarks: ["first"],
      immutable: false,
      conflict: false,
      empty: false,
      current: false,
      files: [],
    },
    {
      commitId: base,
      parentIds: ["0".repeat(40)],
      changeId: "m".repeat(32),
      description: "base",
      bookmarks: ["main"],
      immutable: true,
      conflict: false,
      empty: false,
      current: false,
      files: [],
    },
  ],
});
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
    expect(
      selectJjForgeChain({ ...input, panel: { ...panel, revisions: panel.revisions.slice(0, 2) } })
        .issue,
    ).toContain("outside the loaded revisions");
  });
  it("uses additional visible revisions for a fully loaded chain", () => {
    expect(
      selectJjForgeChain({
        ...input,
        panel: {
          ...panel,
          revisions: panel.revisions.slice(0, 1),
          visibleRevisions: panel.revisions.slice(1),
        },
      }).issue,
    ).toBeNull();
  });
  it("rejects merge ancestry and missing bookmark", () => {
    expect(
      selectJjForgeChain({
        ...input,
        panel: {
          ...panel,
          revisions: panel.revisions.map((revision) =>
            revision.commitId === first ? { ...revision, parentIds: [base, top] } : revision,
          ),
        },
      }).issue,
    ).toContain("without merges");
    expect(
      selectJjForgeChain({
        ...input,
        panel: {
          ...panel,
          revisions: panel.revisions.map((revision) =>
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
