import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { selectJjRevision } from "./jj-diff-selection";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const JJ_CONTEXT = {
  workspaceIdentity: {
    workspaceRoot: "/workspace",
    repositoryPath: "/workspace/.jj/repo",
    workspaceId: "default",
  },
  expectedOperationId: "a".repeat(128),
};
const JJ_COMMIT_ID = "b".repeat(40);
const selection = (ref = THREAD_REF) =>
  selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref);

describe("Jujutsu diff selection", () => {
  beforeEach(() => {
    useDiffPanelStore.setState(useDiffPanelStore.getInitialState(), true);
  });

  it("selects a JJ file with the displayed workspace and operation", () => {
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);

    expect(selection()).toEqual({
      kind: "jj",
      revisionCommitId: JJ_COMMIT_ID,
      filePath: "src/app.ts",
      revealRequestId: 1,
      context: JJ_CONTEXT,
    });
  });

  it("restores the branch base and clears JJ identity when switching to Git", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.selectGitScope(THREAD_REF, "unstaged");
    expect(selection()).toEqual({ kind: "unstaged" });
    store.selectGitScope(THREAD_REF, "branch");
    expect(selection()).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("requests a new reveal for repeated JJ clicks and another revision's file", () => {
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    expect(selection()).toMatchObject({ revealRequestId: 2 });
    selectJjRevision(THREAD_REF, "c".repeat(40), "src/other.ts", JJ_CONTEXT);
    expect(selection()).toMatchObject({
      revisionCommitId: "c".repeat(40),
      filePath: "src/other.ts",
      revealRequestId: 3,
    });
  });

  it("keeps JJ operations and reveals isolated across environments and threads", () => {
    const otherEnvironment = scopeThreadRef(
      EnvironmentId.make("environment-2"),
      THREAD_REF.threadId,
    );
    const otherThread = scopeThreadRef(THREAD_REF.environmentId, ThreadId.make("thread-2"));
    selectJjRevision(otherEnvironment, JJ_COMMIT_ID, "src/app.ts", {
      ...JJ_CONTEXT,
      expectedOperationId: "d".repeat(128),
    });
    useDiffPanelStore.getState().selectBranchBaseRef(otherThread, "origin/main");
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    useDiffPanelStore.getState().removeThread(THREAD_REF);

    expect(selection()).toEqual({ kind: "branch", baseRef: null });
    expect(selection(otherEnvironment)).toMatchObject({
      kind: "jj",
      revealRequestId: 1,
      context: { expectedOperationId: "d".repeat(128) },
    });
    expect(selection(otherThread)).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("does not replace a JJ selection when checkpoint turns are reconciled", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/old.ts");
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.reconcileTurnSelection(THREAD_REF, [RunId.make("turn-2")]);

    expect(selection()).toMatchObject({
      kind: "jj",
      revisionCommitId: JJ_COMMIT_ID,
      filePath: "src/app.ts",
      context: JJ_CONTEXT,
    });
  });

  it("never carries a previous JJ operation into a new unpinned selection", () => {
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    selectJjRevision(THREAD_REF, "c".repeat(40));

    expect(selection()).toEqual({
      kind: "jj",
      revisionCommitId: "c".repeat(40),
      filePath: null,
      revealRequestId: 2,
    });
  });

  it("rehydrates the JJ revision, file, operation, and saved branch base", async () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/release");
    selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    const selected = selection();
    const { storage, name } = useDiffPanelStore.persist.getOptions();
    if (!storage || !name) throw new Error("Diff panel persistence is unavailable.");
    const persisted = await storage.getItem(name);
    if (!persisted) throw new Error("Diff panel selection was not persisted.");
    useDiffPanelStore.getState().removeThread(THREAD_REF);
    await storage.setItem(name, persisted);
    await useDiffPanelStore.persist.rehydrate();

    expect(selection()).toEqual(selected);
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");
    expect(selection()).toEqual({ kind: "branch", baseRef: "origin/release" });
  });
});
