import type { EnvironmentId, JjWorkspaceIdentity } from "@t3tools/contracts";
import { create } from "zustand";
import type { DescriptionDraft } from "./jj-panel-state";

type Drafts = Readonly<Record<string, DescriptionDraft>>;
export const emptyJjDescriptionDrafts: Drafts = {};

export const jjDescriptionDraftScopeKey = (input: {
  environmentId: EnvironmentId;
  cwd: string;
  workspaceIdentity: JjWorkspaceIdentity;
}) =>
  JSON.stringify([
    input.environmentId,
    input.cwd,
    input.workspaceIdentity.repositoryPath,
    input.workspaceIdentity.workspaceRoot,
    input.workspaceIdentity.workspaceId,
  ]);

interface JjDescriptionDraftStore {
  draftsByScope: Readonly<Record<string, Drafts>>;
  clearSavedDraft: (input: {
    scopeKey: string;
    changeId: string;
    savedDraft: DescriptionDraft | undefined;
  }) => void;
  setDrafts: (input: { scopeKey: string; update: (drafts: Drafts) => Drafts }) => void;
}

// Keep unsaved text through panel navigation without writing repository content to storage.
export const useJjDescriptionDraftStore = create<JjDescriptionDraftStore>((set) => ({
  draftsByScope: {},
  clearSavedDraft: (input) =>
    set((state) => {
      const drafts = state.draftsByScope[input.scopeKey];
      if (!drafts || drafts[input.changeId] !== input.savedDraft) return state;
      const next = { ...drafts };
      delete next[input.changeId];
      return { draftsByScope: { ...state.draftsByScope, [input.scopeKey]: next } };
    }),
  setDrafts: (input) =>
    set((state) => ({
      draftsByScope: {
        ...state.draftsByScope,
        [input.scopeKey]: input.update(
          state.draftsByScope[input.scopeKey] ?? emptyJjDescriptionDrafts,
        ),
      },
    })),
}));
