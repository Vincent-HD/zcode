import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";
import {
  buildJjPanelAction,
  visibleJjRevisions,
  otherLoadedJjRevisions,
  selectableJjTargets,
  jjSquashTargets,
  jjFileActionPaths,
  reconcileJjSelection,
  jjActionContextIsCurrent,
  type JjActionFields,
  type JjPanelActionKind,
  descriptionDraftIsStale,
  reconcileDescriptionDrafts,
  jjPanelRequestError,
  formatJjPanelError,
} from "./jj-panel-state";

const revision = { changeId: "change", commitId: "commit-1", description: "Title\n\nFull body\n" };

describe("Jujutsu description drafts", () => {
  it("keeps multiline dirty drafts across snapshots and rejects a rewritten revision", () => {
    const initial = reconcileDescriptionDrafts({ drafts: {}, revisions: [revision] });
    const draft = { ...initial.change!, text: "Edited title\n\nEdited body\n" };
    const rewritten = { ...revision, commitId: "commit-2", description: "External edit\n" };
    const next = reconcileDescriptionDrafts({ drafts: { change: draft }, revisions: [rewritten] });
    expect(next.change).toEqual(draft);
    expect(descriptionDraftIsStale({ draft, revision: rewritten })).toBe(true);
  });

  it("refreshes clean drafts with the canonical server description", () => {
    const initial = reconcileDescriptionDrafts({ drafts: {}, revisions: [revision] });
    const rewritten = { ...revision, commitId: "commit-2", description: "Canonical\n\nBody\n" };
    const next = reconcileDescriptionDrafts({ drafts: initial, revisions: [rewritten] });
    expect(next.change?.text).toBe(rewritten.description);
    expect(descriptionDraftIsStale({ draft: next.change!, revision: rewritten })).toBe(false);
  });

  it("retains drafts when a revision temporarily disappears", () => {
    const initial = reconcileDescriptionDrafts({ drafts: {}, revisions: [revision] });
    expect(reconcileDescriptionDrafts({ drafts: initial, revisions: [] })).toEqual(initial);
  });

  it("gives an old remote a helpful unsupported message", () => {
    expect(jjPanelRequestError("Unknown method jj.getPanel")).toContain("Update that server");
    expect(formatJjPanelError(Cause.die("Unknown request tag: jj.getPanel"))).toContain(
      "Update that server",
    );
    expect(jjPanelRequestError("Permission denied")).toBe("Permission denied");
  });
});

const sourceId = "a".repeat(40);
const targetId = "b".repeat(40);
const immutableId = "c".repeat(40);
const conflictId = "d".repeat(40);
const sourceRevision = {
  commitId: sourceId,
  immutable: false,
  conflict: false,
  files: [{ path: "src/a.ts" }, { path: "src/odd [name].ts" }],
};
const targets = [
  sourceRevision,
  { commitId: targetId, immutable: false, conflict: false },
  { commitId: immutableId, immutable: true, conflict: false },
  { commitId: conflictId, immutable: false, conflict: true },
];
const fields: JjActionFields = {
  targetCommitIds: [targetId],
  paths: [],
  allFiles: true,
  description: "Title\n\nBody\n",
  replaceMessage: false,
  bookmarkName: "topic",
  bookmarkNames: ["topic"],
  remote: "origin",
};
const makeAction = (input: {
  kind: JjPanelActionKind;
  fields?: Partial<JjActionFields>;
  sourceCommitId?: string;
  selectedCommitIds?: string[];
  revisions?: typeof targets;
  filesTruncated?: boolean;
}) =>
  buildJjPanelAction({
    kind: input.kind,
    sourceCommitId: input.sourceCommitId ?? sourceId,
    selectedCommitIds: input.selectedCommitIds ?? [],
    fields: { ...fields, ...input.fields },
    revisions: input.revisions ?? targets,
    workingCopyCommitId: sourceId,
    filesTruncated: input.filesTruncated ?? false,
  });

describe("Jujutsu quick squash destinations and file scope", () => {
  const revisions = [
    { ...sourceRevision, parentIds: [targetId] },
    { ...targets[1]!, parentIds: [immutableId] },
    { ...targets[2]!, parentIds: [conflictId] },
    { ...targets[3]!, parentIds: ["e".repeat(40)] },
    { commitId: "e".repeat(40), immutable: false, conflict: false, parentIds: [] },
    { commitId: "f".repeat(40), immutable: false, conflict: false, parentIds: [targetId] },
  ];

  it("offers eligible ancestors without siblings, immutable or conflicted destinations", () => {
    expect(
      jjSquashTargets({ source: revisions[0]!, revisions, scope: "ancestors" }).map(
        (revision) => revision.commitId,
      ),
    ).toEqual([targetId, "e".repeat(40)]);
    expect(
      jjSquashTargets({ source: revisions[0]!, revisions, scope: "parent" }).map(
        (revision) => revision.commitId,
      ),
    ).toEqual([targetId]);
    expect(jjSquashTargets({ source: revisions[1]!, revisions, scope: "parent" })).toEqual([]);
  });

  it("offers both eligible merge parents and stops at unloaded history", () => {
    const source = { ...revisions[0]!, parentIds: [targetId, "e".repeat(40), "unloaded"] };
    expect(
      jjSquashTargets({ source, revisions, scope: "parent" }).map((revision) => revision.commitId),
    ).toEqual([targetId, "e".repeat(40)]);
    expect(
      jjSquashTargets({
        source: { ...source, parentIds: ["unloaded"] },
        revisions,
        scope: "ancestors",
      }),
    ).toEqual([]);
  });

  it("moves only checked files when acting on a checked row, otherwise only the clicked file", () => {
    const selectedPaths = ["src/a.ts", "src/odd [name].ts"];
    const paths = jjFileActionPaths({ path: "src/a.ts", selectedPaths });
    expect(paths).toEqual(selectedPaths);
    expect(jjFileActionPaths({ path: "src/unselected.ts", selectedPaths })).toEqual([
      "src/unselected.ts",
    ]);
    expect(makeAction({ kind: "squash-into", fields: { paths, allFiles: false } })).toEqual({
      type: "squash",
      sourceCommitId: sourceId,
      destinationCommitId: targetId,
      mode: "into",
      paths,
    });
    expect(
      makeAction({ kind: "restore", fields: { paths, allFiles: false, targetCommitIds: [] } }),
    ).toEqual({ type: "restore", revisionCommitId: sourceId, paths });
    expect(
      makeAction({ kind: "squash-into", fields: { paths: [], allFiles: true } }),
    ).not.toHaveProperty("paths");
  });
});

describe("Jujutsu panel revision selection", () => {
  it("shows only the current revision and ten reachable ancestors, excluding sibling targets", () => {
    const revisions = Array.from({ length: 14 }, (_, index) => ({
      commitId: String(index),
      parentIds: index < 13 ? [String(index + 1)] : [],
    }));
    revisions.push({ commitId: "sibling", parentIds: ["1"] });
    const visible = visibleJjRevisions({
      revisions: revisions.toReversed(),
      workingCopyCommitId: "0",
    });
    expect(visible.map((revision) => revision.commitId)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index)),
    );
  });

  it("keeps siblings and deeper history available as sources without adding main rows", () => {
    const revisions = Array.from({ length: 14 }, (_, index) => ({
      commitId: String(index),
      parentIds: index < 13 ? [String(index + 1)] : [],
    }));
    revisions.push({ commitId: "sibling", parentIds: ["1"] });
    const visibleRevisions = visibleJjRevisions({ revisions, workingCopyCommitId: "0" });
    const other = otherLoadedJjRevisions({ revisions, visibleRevisions });
    expect(visibleRevisions).toHaveLength(11);
    expect(other.map((revision) => revision.commitId)).toEqual(["11", "12", "13", "sibling"]);
    expect(
      reconcileJjSelection({ selectedCommitIds: ["sibling", "0", "missing"], revisions }),
    ).toEqual(["sibling", "0"]);
    expect(
      reconcileJjSelection({
        selectedCommitIds: ["sibling"],
        revisions: revisions.filter((revision) => revision.commitId !== "sibling"),
      }),
    ).toEqual([]);
  });

  it("builds edit, duplicate, selected-file squash and multi-source actions from a sibling", () => {
    const siblingId = "e".repeat(40);
    const sibling = { ...sourceRevision, commitId: siblingId };
    const revisions = [...targets, sibling];
    expect(makeAction({ kind: "edit", sourceCommitId: siblingId, revisions })).toEqual({
      type: "edit",
      revisionCommitId: siblingId,
    });
    expect(makeAction({ kind: "duplicate", sourceCommitId: siblingId, revisions })).toEqual({
      type: "duplicate",
      revisionCommitId: siblingId,
      destinationCommitIds: [targetId],
    });
    expect(
      makeAction({
        kind: "squash-into",
        sourceCommitId: siblingId,
        revisions,
        fields: { allFiles: false, paths: ["src/a.ts"] },
      }),
    ).toEqual({
      type: "squash",
      sourceCommitId: siblingId,
      destinationCommitId: targetId,
      mode: "into",
      paths: ["src/a.ts"],
    });
    expect(
      makeAction({
        kind: "abandon",
        sourceCommitId: siblingId,
        revisions,
        selectedCommitIds: [sourceId, siblingId],
      }),
    ).toEqual({ type: "abandon", revisionCommitIds: [sourceId, siblingId] });
  });

  it("deduplicates merged ancestors and tolerates missing history", () => {
    const revisions = [
      { commitId: "wc", parentIds: ["left", "right", "missing"] },
      { commitId: "left", parentIds: ["base"] },
      { commitId: "right", parentIds: ["base"] },
      { commitId: "base", parentIds: [] },
    ];
    expect(
      visibleJjRevisions({ revisions, workingCopyCommitId: "wc" }).map(
        (revision) => revision.commitId,
      ),
    ).toEqual(["wc", "left", "right", "base"]);
    expect(visibleJjRevisions({ revisions, workingCopyCommitId: "other" })).toEqual([]);
  });

  it("drops rewritten commit selections rather than silently selecting their replacement", () => {
    expect(
      reconcileJjSelection({
        selectedCommitIds: [sourceId, targetId],
        revisions: [{ commitId: immutableId }, { commitId: targetId }],
      }),
    ).toEqual([targetId]);
  });

  it("offers mutable clean squash destinations and immutable parents for onto", () => {
    expect(
      selectableJjTargets({
        kind: "squash-into",
        sourceCommitId: sourceId,
        revisions: targets,
      }).map((revision) => revision.commitId),
    ).toEqual([targetId]);
    expect(
      selectableJjTargets({
        kind: "squash-onto",
        sourceCommitId: sourceId,
        revisions: targets,
      }).map((revision) => revision.commitId),
    ).toEqual([targetId, immutableId]);
  });

  it("invalidates confirmations on operation, repository, or unavailable changes", () => {
    const captured = {
      operationId: "one",
      workspaceIdentity: { repositoryPath: "/repo", workspaceId: "default" },
    };
    expect(jjActionContextIsCurrent({ captured, current: { ...captured } })).toBe(true);
    expect(
      jjActionContextIsCurrent({ captured, current: { ...captured, operationId: "two" } }),
    ).toBe(false);
    expect(
      jjActionContextIsCurrent({
        captured,
        current: {
          ...captured,
          workspaceIdentity: { repositoryPath: "/other", workspaceId: "default" },
        },
      }),
    ).toBe(false);
    expect(jjActionContextIsCurrent({ captured, current: null })).toBe(false);
  });
});

describe("Jujutsu panel action generation", () => {
  it("keeps whole and selected-file squash distinct and requires valid destinations", () => {
    expect(makeAction({ kind: "squash-into" })).toEqual({
      type: "squash",
      sourceCommitId: sourceId,
      destinationCommitId: targetId,
      mode: "into",
    });
    expect(
      makeAction({
        kind: "squash-onto",
        fields: {
          allFiles: false,
          paths: ["src/odd [name].ts"],
          targetCommitIds: [immutableId],
          replaceMessage: true,
          description: "Replacement\n",
        },
      }),
    ).toEqual({
      type: "squash",
      sourceCommitId: sourceId,
      destinationCommitId: immutableId,
      mode: "onto",
      paths: ["src/odd [name].ts"],
      messagePolicy: { type: "replace", description: "Replacement\n" },
    });
    for (const targetCommitIds of [
      [],
      [sourceId],
      [immutableId],
      [conflictId],
      [targetId, immutableId],
      ["f".repeat(40)],
    ]) {
      expect(makeAction({ kind: "squash-into", fields: { targetCommitIds } })).toBeNull();
    }
  });

  it("rejects an empty file selection and paths that no longer belong to the source", () => {
    expect(makeAction({ kind: "absorb", fields: { allFiles: false, paths: [] } })).toBeNull();
    expect(
      makeAction({ kind: "absorb", fields: { allFiles: false, paths: ["src/disappeared.ts"] } }),
    ).toBeNull();
    expect(
      makeAction({ kind: "absorb", fields: { allFiles: false, paths: ["src/a.ts"] } }),
    ).toEqual({ type: "absorb", revisionCommitId: sourceId, paths: ["src/a.ts"] });
  });

  it("restores all known exact paths and never pretends a truncated list is complete", () => {
    expect(makeAction({ kind: "restore" })).toEqual({
      type: "restore",
      revisionCommitId: sourceId,
      paths: ["src/a.ts", "src/odd [name].ts"],
    });
    expect(makeAction({ kind: "restore", filesTruncated: true })).toBeNull();
    expect(
      makeAction({
        kind: "restore",
        filesTruncated: true,
        fields: { allFiles: false, paths: ["src/a.ts"] },
      }),
    ).toEqual({ type: "restore", revisionCommitId: sourceId, paths: ["src/a.ts"] });
  });

  it("commits only the current working copy and preserves the exact multiline message", () => {
    expect(makeAction({ kind: "commit" })).toEqual({
      type: "commit",
      description: fields.description,
    });
    expect(makeAction({ kind: "commit", sourceCommitId: targetId })).toBeNull();
    expect(makeAction({ kind: "edit", sourceCommitId: immutableId })).toBeNull();
  });

  it("distinguishes single and branch rebase and leaves duplicate parents optional", () => {
    expect(makeAction({ kind: "rebase-revision" })).toEqual({
      type: "rebase",
      revisionCommitId: sourceId,
      destinationCommitIds: [targetId],
      mode: "revision",
    });
    expect(makeAction({ kind: "rebase-branch" })).toEqual({
      type: "rebase",
      revisionCommitId: sourceId,
      destinationCommitIds: [targetId],
      mode: "branch",
    });
    expect(makeAction({ kind: "duplicate", fields: { targetCommitIds: [] } })).toEqual({
      type: "duplicate",
      revisionCommitId: sourceId,
    });
    expect(makeAction({ kind: "duplicate", fields: { targetCommitIds: [immutableId] } })).toEqual({
      type: "duplicate",
      revisionCommitId: sourceId,
      destinationCommitIds: [immutableId],
    });
  });

  it("uses the frozen selected revisions for abandon and insertion", () => {
    const selectedCommitIds = [sourceId, targetId];
    expect(makeAction({ kind: "abandon", selectedCommitIds })).toEqual({
      type: "abandon",
      revisionCommitIds: selectedCommitIds,
    });
    expect(makeAction({ kind: "insert-before", selectedCommitIds })).toEqual({
      type: "insert",
      revisionCommitIds: selectedCommitIds,
      position: "before",
    });
    expect(makeAction({ kind: "insert-after", selectedCommitIds })).toEqual({
      type: "insert",
      revisionCommitIds: selectedCommitIds,
      position: "after",
    });
    expect(makeAction({ kind: "abandon", selectedCommitIds: [sourceId, immutableId] })).toBeNull();
    expect(makeAction({ kind: "abandon", selectedCommitIds: ["f".repeat(40)] })).toBeNull();
  });

  it("requires multiple merge parents and explicit new parents", () => {
    expect(makeAction({ kind: "merge" })).toBeNull();
    expect(
      makeAction({ kind: "merge", fields: { targetCommitIds: [sourceId, targetId] } }),
    ).toEqual({ type: "merge", parentCommitIds: [sourceId, targetId] });
    expect(makeAction({ kind: "new", fields: { targetCommitIds: [] } })).toBeNull();
    expect(makeAction({ kind: "new", fields: { targetCommitIds: [immutableId] } })).toEqual({
      type: "new",
      parentCommitIds: [immutableId],
    });
  });

  it("requires explicit valid bookmark names and remote for network publication", () => {
    expect(makeAction({ kind: "push", fields: { bookmarkNames: [] } })).toBeNull();
    expect(makeAction({ kind: "push", fields: { remote: "" } })).toBeNull();
    expect(makeAction({ kind: "push", fields: { bookmarkNames: ["topic", "--all"] } })).toBeNull();
    expect(makeAction({ kind: "push" })).toEqual({
      type: "push",
      bookmarkNames: ["topic"],
      remote: "origin",
    });
    expect(makeAction({ kind: "bookmark-set" })).toEqual({
      type: "bookmark-set",
      name: "topic",
      revisionCommitId: sourceId,
    });
    expect(makeAction({ kind: "bookmark-advance" })).toEqual({
      type: "bookmark-advance",
      name: "topic",
      revisionCommitId: sourceId,
    });
    expect(makeAction({ kind: "bookmark-delete" })).toEqual({
      type: "bookmark-delete",
      name: "topic",
    });
    expect(
      makeAction({ kind: "bookmark-set", fields: { bookmarkName: "invalid name" } }),
    ).toBeNull();
  });

  it("allows insertion after immutable parents while blocking conflicted rewrite targets", () => {
    expect(
      makeAction({
        kind: "insert-after",
        sourceCommitId: immutableId,
        selectedCommitIds: [immutableId],
      }),
    ).toEqual({ type: "insert", revisionCommitIds: [immutableId], position: "after" });
    expect(makeAction({ kind: "insert-before", selectedCommitIds: [immutableId] })).toBeNull();
    expect(
      makeAction({ kind: "rebase-revision", fields: { targetCommitIds: [conflictId] } }),
    ).toBeNull();
    expect(
      makeAction({
        kind: "commit",
        revisions: targets.map((revision) =>
          revision.commitId === sourceId ? { ...revision, conflict: true } : revision,
        ),
      }),
    ).toBeNull();
  });

  it("supports general undo and redo without an owned receipt", () => {
    expect(makeAction({ kind: "undo" })).toEqual({ type: "undo" });
    expect(makeAction({ kind: "redo" })).toEqual({ type: "redo" });
  });

  it("retains an unsaved draft when an action rewrites its commit and when its revision disappears", () => {
    const draft = {
      text: "User draft\n\nBody",
      baseDescription: "Original",
      baseCommitId: sourceId,
    };
    const drafts = { change: draft };
    const afterAction = reconcileDescriptionDrafts({
      drafts,
      revisions: [{ changeId: "change", commitId: targetId, description: "External action" }],
    });
    expect(afterAction.change).toEqual(draft);
    expect(
      descriptionDraftIsStale({
        draft: afterAction.change!,
        revision: { commitId: targetId, description: "External action" },
      }),
    ).toBe(true);
    expect(reconcileDescriptionDrafts({ drafts: afterAction, revisions: [] }).change).toEqual(
      draft,
    );
  });
});
