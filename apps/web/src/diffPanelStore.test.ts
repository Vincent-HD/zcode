import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resolveToolCallDiffTarget,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

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

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("keeps a tool call selection independent of checkpoints and allows returning to Git changes", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const target = {
      threadId: ThreadId.make("child"),
      itemId: TurnItemId.make("edit"),
      revision: "1",
    };
    const store = useDiffPanelStore.getState();
    store.selectToolCall(ref, target);
    store.reconcileTurnSelection(ref, []);
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "tool-call",
      ...target,
    });
    store.selectGitScope(ref, "branch");
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("refreshes a live tool-call target when its source item completes", () => {
    const target = {
      threadId: ThreadId.make("child"),
      itemId: TurnItemId.make("edit"),
      revision: "live",
    };
    const now = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
    const row = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: target.threadId,
      sourceItemId: target.itemId,
      item: {
        id: target.itemId,
        threadId: target.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "file_change" as const,
        fileName: "a.ts",
      },
    };
    expect(resolveToolCallDiffTarget(target, [row])).toBe(target);
    const completed = {
      ...row,
      item: { ...row.item, status: "completed" as const, completedAt: now },
    };
    expect(resolveToolCallDiffTarget(target, [completed])).toEqual({
      ...target,
      revision: DateTime.formatIso(now),
    });
    expect(
      resolveToolCallDiffTarget(target, [{ ...completed, sourceThreadId: ThreadId.make("other") }]),
    ).toBe(target);
    expect(resolveToolCallDiffTarget(target, [])).toBe(target);
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });

  it("selects a JJ file with the displayed workspace and operation", () => {
    useDiffPanelStore
      .getState()
      .selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
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
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.selectGitScope(THREAD_REF, "unstaged");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "unstaged",
    });
    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "branch",
      baseRef: "origin/release",
    });
  });

  it("requests a new reveal for repeated JJ clicks and another revision's file", () => {
    const store = useDiffPanelStore.getState();
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      revealRequestId: 2,
    });
    store.selectJjRevision(THREAD_REF, "c".repeat(40), "src/other.ts", JJ_CONTEXT);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
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
    const store = useDiffPanelStore.getState();
    store.selectJjRevision(otherEnvironment, JJ_COMMIT_ID, "src/app.ts", {
      ...JJ_CONTEXT,
      expectedOperationId: "d".repeat(128),
    });
    store.selectBranchBaseRef(otherThread, "origin/main");
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.removeThread(THREAD_REF);

    const { byThreadKey } = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({
      kind: "branch",
      baseRef: null,
    });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherEnvironment)).toMatchObject({
      kind: "jj",
      revealRequestId: 1,
      context: { expectedOperationId: "d".repeat(128) },
    });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherThread)).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });
  });

  it("does not replace a JJ selection when checkpoint turns are reconciled", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/old.ts");
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.reconcileTurnSelection(THREAD_REF, [RunId.make("turn-2")]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      kind: "jj",
      revisionCommitId: JJ_COMMIT_ID,
      filePath: "src/app.ts",
      context: JJ_CONTEXT,
    });
  });

  it("never carries a previous JJ operation into a new unpinned selection", () => {
    const store = useDiffPanelStore.getState();
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    store.selectJjRevision(THREAD_REF, "c".repeat(40));

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "jj",
      revisionCommitId: "c".repeat(40),
      filePath: null,
      revealRequestId: 2,
    });
  });

  it("rehydrates the JJ revision, file, operation, and saved branch base", async () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectJjRevision(THREAD_REF, JJ_COMMIT_ID, "src/app.ts", JJ_CONTEXT);
    const selected = selectThreadDiffPanelSelection(
      useDiffPanelStore.getState().byThreadKey,
      THREAD_REF,
    );
    const { storage, name } = useDiffPanelStore.persist.getOptions();
    expect(storage).toBeDefined();
    expect(name).toBeDefined();
    if (!storage || !name) throw new Error("Diff panel persistence is unavailable.");
    const persisted = await storage.getItem(name);
    if (!persisted) throw new Error("Diff panel selection was not persisted.");
    store.removeThread(THREAD_REF);
    await storage.setItem(name, persisted);
    await useDiffPanelStore.persist.rehydrate();

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual(selected);
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "branch",
      baseRef: "origin/release",
    });
  });
});
