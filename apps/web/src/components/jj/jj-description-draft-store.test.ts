import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { descriptionDraftIsStale, reconcileDescriptionDrafts } from "./jj-panel-state";
import {
  jjDescriptionDraftScopeKey,
  useJjDescriptionDraftStore,
} from "./jj-description-draft-store";

const scope = {
  environmentId: EnvironmentId.make("local"),
  cwd: "/repo",
  workspaceIdentity: {
    repositoryPath: "/repo/.jj/repo",
    workspaceRoot: "/repo",
    workspaceId: "default",
  },
};
const revision = { changeId: "change", commitId: "commit-1", description: "Title\n\nBody\n" };
const draft = {
  text: "Draft\n\nUnsaved body\n",
  baseDescription: revision.description,
  baseCommitId: revision.commitId,
};
const scopeKey = jjDescriptionDraftScopeKey(scope);

beforeEach(() => useJjDescriptionDraftStore.setState({ draftsByScope: {} }));

describe("Jujutsu description draft store", () => {
  it("retains a dirty multiline draft after the panel unsubscribes and returns", () => {
    const unsubscribe = useJjDescriptionDraftStore.subscribe(() => {});
    useJjDescriptionDraftStore
      .getState()
      .setDrafts({ scopeKey, update: () => ({ change: draft }) });
    unsubscribe();
    const unsubscribeRemount = useJjDescriptionDraftStore.subscribe(() => {});
    useJjDescriptionDraftStore.getState().setDrafts({
      scopeKey,
      update: (drafts) => reconcileDescriptionDrafts({ drafts, revisions: [revision] }),
    });
    expect(useJjDescriptionDraftStore.getState().draftsByScope[scopeKey]?.change).toEqual(draft);
    unsubscribeRemount();
  });

  it("isolates environments, cwd, repositories, workspace roots and workspace IDs", () => {
    useJjDescriptionDraftStore
      .getState()
      .setDrafts({ scopeKey, update: () => ({ change: draft }) });
    const otherScopes = [
      { ...scope, environmentId: EnvironmentId.make("remote") },
      { ...scope, cwd: "/repo/subdir" },
      {
        ...scope,
        workspaceIdentity: { ...scope.workspaceIdentity, repositoryPath: "/other/.jj/repo" },
      },
      { ...scope, workspaceIdentity: { ...scope.workspaceIdentity, workspaceRoot: "/other" } },
      { ...scope, workspaceIdentity: { ...scope.workspaceIdentity, workspaceId: "second" } },
    ];
    for (const otherScope of otherScopes) {
      const otherKey = jjDescriptionDraftScopeKey(otherScope);
      useJjDescriptionDraftStore.getState().setDrafts({
        scopeKey: otherKey,
        update: (drafts) => reconcileDescriptionDrafts({ drafts, revisions: [revision] }),
      });
      expect(useJjDescriptionDraftStore.getState().draftsByScope[otherKey]?.change?.text).toBe(
        revision.description,
      );
    }
    expect(useJjDescriptionDraftStore.getState().draftsByScope[scopeKey]?.change).toEqual(draft);
  });

  it("preserves stale drafts after an unavailable snapshot and a rewritten revision", () => {
    useJjDescriptionDraftStore
      .getState()
      .setDrafts({ scopeKey, update: () => ({ change: draft }) });
    useJjDescriptionDraftStore.getState().setDrafts({
      scopeKey,
      update: (drafts) => reconcileDescriptionDrafts({ drafts, revisions: [] }),
    });
    const rewritten = { ...revision, commitId: "commit-2", description: "External edit" };
    useJjDescriptionDraftStore.getState().setDrafts({
      scopeKey,
      update: (drafts) => reconcileDescriptionDrafts({ drafts, revisions: [rewritten] }),
    });
    const retained = useJjDescriptionDraftStore.getState().draftsByScope[scopeKey]?.change;
    expect(retained).toEqual(draft);
    expect(descriptionDraftIsStale({ draft: retained!, revision: rewritten })).toBe(true);
  });

  it("can discard a stale draft and resume from the canonical description", () => {
    useJjDescriptionDraftStore
      .getState()
      .setDrafts({ scopeKey, update: () => ({ change: draft }) });
    const rewritten = { ...revision, commitId: "commit-2", description: "External edit" };
    useJjDescriptionDraftStore.getState().setDrafts({
      scopeKey,
      update: () => reconcileDescriptionDrafts({ drafts: {}, revisions: [rewritten] }),
    });
    expect(useJjDescriptionDraftStore.getState().draftsByScope[scopeKey]?.change?.text).toBe(
      rewritten.description,
    );
    expect(
      descriptionDraftIsStale({
        draft: useJjDescriptionDraftStore.getState().draftsByScope[scopeKey]!.change!,
        revision: rewritten,
      }),
    ).toBe(false);
  });
  it("clears a successfully saved draft after navigation without clearing other workspaces", () => {
    const otherKey = jjDescriptionDraftScopeKey({ ...scope, cwd: "/other" });
    for (const key of [scopeKey, otherKey])
      useJjDescriptionDraftStore
        .getState()
        .setDrafts({ scopeKey: key, update: () => ({ change: draft }) });
    useJjDescriptionDraftStore
      .getState()
      .clearSavedDraft({ scopeKey, changeId: "change", savedDraft: draft });
    expect(useJjDescriptionDraftStore.getState().draftsByScope[scopeKey]?.change).toBeUndefined();
    expect(useJjDescriptionDraftStore.getState().draftsByScope[otherKey]?.change).toEqual(draft);
  });
  it("retains newer edits when an earlier save finishes after navigation", () => {
    const newerDraft = { ...draft, text: "Newer unsaved text" };
    useJjDescriptionDraftStore
      .getState()
      .setDrafts({ scopeKey, update: () => ({ change: newerDraft }) });
    useJjDescriptionDraftStore
      .getState()
      .clearSavedDraft({ scopeKey, changeId: "change", savedDraft: draft });
    expect(useJjDescriptionDraftStore.getState().draftsByScope[scopeKey]?.change).toEqual(
      newerDraft,
    );
  });
});
