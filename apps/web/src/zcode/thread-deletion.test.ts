import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useDiffPanelStore } from "../diffPanelStore";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useTemporaryConversationStore } from "./temporary-conversation-store";

const state = vi.hoisted(() => ({
  serverConfig: { shellThreadFamilies: false },
  familyLookupFails: false,
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    worktreePath: string | null;
    lineage: { parentThreadId: ThreadId | null; sideChat?: boolean };
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
  }[],
  familyThreads: [] as {
    id: ThreadId;
    lineage: { parentThreadId: ThreadId | null; sideChat?: boolean };
  }[],
  requests: [] as { action: string; environmentId: string; input: { threadId?: string } }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as string[],
  afterRequest: undefined as ((action: string) => void) | undefined,
  sessionLookupFails: false,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { href: "/" }, matches: [] }, navigate: async () => {} }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: { environmentId: string; input: { threadId?: string } }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      state.afterRequest?.(action);
      return AsyncResult.success(undefined);
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: unknown) => async (environmentId: string) =>
    family === "threadFamily"
      ? state.familyLookupFails
        ? AsyncResult.failure(Cause.fail(new Error("Family lookup failed")))
        : AsyncResult.success({ threads: state.familyThreads })
      : state.sessionLookupFails
        ? AsyncResult.failure(Cause.fail(new Error("Session lookup failed")))
        : AsyncResult.success({
            authenticated: true,
            scopes: [...(state.scopes.get(environmentId) ?? [])],
            auth: { serverUpdateScope: "environment:maintain" },
          }),
}));
vi.mock("../state/orchestration", () => ({
  orchestrationEnvironment: { threadFamily: "threadFamily" },
}));
vi.mock("../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentServerConfigsAtom: Atom.make(new Map([["secondary", state.serverConfig]])),
  };
});
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: (ref: ScopedThreadRef) =>
        state.localEffects.push(`clear-draft:${ref.threadId}`),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: (ref: ScopedThreadRef) =>
    state.localEffects.push(`release-uploads:${ref.threadId}`),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => null,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title?: string }) => {
      if (toast.title) state.toasts.push(toast.title);
    },
  },
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: true,
    }),
}));

import { useThreadActions } from "../hooks/useThreadActions";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
beforeEach(() => {
  state.serverConfig.shellThreadFamilies = false;
  state.familyLookupFails = false;
  state.familyThreads = [];
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      lineage: { parentThreadId: null },
      session: null,
      latestTurn: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.toasts = [];
  state.afterRequest = undefined;
  state.sessionLookupFails = false;
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  useDiffPanelStore.setState(useDiffPanelStore.getInitialState(), true);
  usePreviewMiniPlayerStore.setState(usePreviewMiniPlayerStore.getInitialState(), true);
});

describe("temporary conversation deletion", () => {
  it("clears the temporary marker when a thread is deleted", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    useTemporaryConversationStore.getState().setTemporaryThread(scopedThreadKey(target), true);
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(useTemporaryConversationStore.getState().temporaryThreadKeys).toEqual([]);
  });

  it("deletes a temporary thread without removing its worktree", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    useTemporaryConversationStore.getState().setTemporaryThread(scopedThreadKey(target), true);

    const result = await useThreadActions().deleteThread(target, { deleteWorktree: false });

    expect(result._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
    expect(useTemporaryConversationStore.getState().temporaryThreadKeys).toEqual([]);
  });
});
