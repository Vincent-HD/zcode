import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type JjLogRow,
  type JjPanelReady,
  type JjRunAction,
  type PullRequestState,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useGT } from "gt-react";
import {
  BookmarkPlusIcon,
  ChevronDownIcon,
  CloudUploadIcon,
  GitCommitHorizontalIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { useOpenLink } from "../browser/useOpenLink";
import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "../components/chat/threadDetailsPanelStyles";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { JjActionDialog } from "../components/jj/jj-action-dialog";
import { jjForgeFailureMessage } from "../components/jj/jj-forge-state";
import { jjRefreshInput, mergeJjSnapshot } from "../components/jj/jj-log-state";
import { formatJjPanelError } from "../components/jj/jj-panel-state";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { cn } from "../lib/utils";
import { useQuietThreadShell, useServerConfigs } from "../state/entities";
import { jjEnvironment } from "../state/jj";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import {
  JJ_GIT_ACTIONS_VIEW,
  jjGitActionBlocker,
  jjGitActionsState,
  jjNextBookmarkName,
  jjQuickAction,
  jjRemoteBookmarkView,
  type JjGitAction,
} from "./jj-git-actions";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const ICONS = {
  commit: GitCommitHorizontalIcon,
  push: CloudUploadIcon,
  "create-pr": PullRequestGlyph.pullRequest,
  "view-pr": PullRequestGlyph.link,
  "publish-stack": PullRequestGlyph.stack,
} as const;

interface BookmarkPullRequest {
  readonly url: string;
  readonly number: number;
  readonly state: PullRequestState;
}

/** Where each of the stack's bookmarks sits now, before Push moves the work's own up. */
const bookmarkPlacements = (state: ReturnType<typeof jjGitActionsState>) =>
  state.stack.flatMap((entry) =>
    entry.bookmark === null
      ? []
      : [
          {
            bookmark: entry.bookmark,
            commitId:
              entry.bookmark === state.bookmark && state.bookmarkCommitId
                ? state.bookmarkCommitId
                : entry.row.commitId,
          },
        ],
  );

/**
 * Git's actions see a jj workspace as a detached HEAD with nothing to push. In one, this row
 * commits, pushes, and opens pull requests through jj instead; elsewhere it renders Git's.
 */
interface JjGitActionsControlProps {
  target: { readonly cwd: string; readonly name: string } | null;
  threadRef: ScopedThreadRef | null;
  owner?: { readonly projectId?: ProjectId } | undefined;
  compact?: boolean | undefined;
  showActions?: boolean | undefined;
  /** Git's control, told whether to show its own action row. */
  render: (showActions: boolean) => ReactNode;
}

export const JjGitActionsControl = (props: JjGitActionsControlProps) =>
  props.threadRef && props.target && props.showActions !== false ? (
    <WorkspaceJjGitActions
      {...props}
      environmentId={props.threadRef.environmentId}
      cwd={props.target.cwd}
    />
  ) : (
    props.render(props.showActions !== false)
  );

const WorkspaceJjGitActions = (
  props: JjGitActionsControlProps & { environmentId: EnvironmentId; cwd: string },
) => {
  const gt = useGT();
  const { environmentId, cwd } = props;
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const enabled = capabilities?.jjPanel === true && capabilities.jjPanelActions === true && canRead;
  const canRun = useAtomValue(jjEnvironment.runAction.permissionAtom(environmentId));
  const canPublish = useAtomValue(jjEnvironment.forgePublish.permissionAtom(environmentId));
  const threadProjectId = useQuietThreadShell(props.threadRef)?.projectId;
  const projectId = props.owner?.projectId ?? threadProjectId ?? null;
  const getPanel = useAtomCommand(jjEnvironment.getPanel, COMMAND_OPTIONS);
  const runAction = useAtomCommand(jjEnvironment.runAction, COMMAND_OPTIONS);
  const forgePreview = useAtomCommand(jjEnvironment.forgePreview, COMMAND_OPTIONS);
  const forgePublish = useAtomCommand(jjEnvironment.forgePublish, COMMAND_OPTIONS);
  const forgeStatus = useAtomCommand(jjEnvironment.forgeStatus, COMMAND_OPTIONS);
  const stackLink = useAtomCommand(jjEnvironment.stackLink, COMMAND_OPTIONS);
  const generateCommitMessage = useAtomCommand(
    jjEnvironment.generateCommitMessage,
    COMMAND_OPTIONS,
  );
  const canGenerate = useAtomValue(
    jjEnvironment.generateCommitMessage.permissionAtom(environmentId),
  );
  const openLink = useOpenLink(props.threadRef);
  // Git's control holds this subscription too; its updates say the checkout moved.
  const { data: gitStatus } = useEnvironmentQuery(
    enabled ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null,
  );

  const [panel, setPanel] = useState<JjPanelReady | null>(null);
  const [notJj, setNotJj] = useState(false);
  const [remoteHead, setRemoteHead] = useState<{
    readonly bookmark: string;
    readonly commitId: string | null;
  } | null>(null);
  const [pullRequests, setPullRequests] = useState<ReadonlyMap<string, BookmarkPullRequest>>(
    new Map(),
  );
  // The bookmark placements last asked about, so a refresh does not query the forge again.
  const pullRequestKey = useRef<string | null>(null);
  const [bookmarking, setBookmarking] = useState<{
    readonly revision: JjLogRow;
    readonly suggestedName: string;
  } | null>(null);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const [running, setRunning] = useState<JjGitAction | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const panelRef = useRef<JjPanelReady | null>(null);
  const generation = useRef(0);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const accept = (next: JjPanelReady) => {
    panelRef.current = next;
    setPanel(next);
  };

  const refresh = async (reload = false): Promise<void> => {
    if (!enabled) return;
    const current = reload ? null : panelRef.current;
    const request = ++generation.current;
    const result = await getPanel({
      environmentId,
      input: jjRefreshInput({ cwd, view: JJ_GIT_ACTIONS_VIEW, current }),
    });
    if (request !== generation.current || !AsyncResult.isSuccess(result)) return;
    const merge = mergeJjSnapshot(current, result.value);
    if (merge.type === "replace") accept(merge.panel);
    if (merge.type === "unavailable") {
      panelRef.current = null;
      setPanel(null);
      setNotJj(true);
    }
    if (merge.type === "reload" && !reload) return refresh(true);
    // A push moves only the remote bookmark, which the unchanged snapshot does not show.
    if (panelRef.current) await readRemoteHead(panelRef.current, request);
    if (panelRef.current) await readPullRequests(panelRef.current);
  };
  /** Finds each stack bookmark's pull request once per bookmark placement. */
  const readPullRequests = async (next: JjPanelReady) => {
    const nextState = jjGitActionsState({
      rows: next.rows,
      workingCopyCommitId: next.workingCopyCommitId,
      remotes: next.remotes,
    });
    if (capabilities?.jjPanelForge !== true || projectId === null || !nextState.remote) return;
    const placements = bookmarkPlacements(nextState);
    if (placements.length === 0) return;
    const key = JSON.stringify(placements);
    if (pullRequestKey.current === key) return;
    pullRequestKey.current = key;
    const result = await forgeStatus({
      environmentId,
      input: {
        cwd,
        workspaceIdentity: next.workspaceIdentity,
        expectedOperationId: next.operationId,
        projectId,
        remote: nextState.remote,
        revisionCommitIds: [...new Set(placements.map((placement) => placement.commitId))].slice(
          0,
          32,
        ),
      },
    });
    if (result._tag !== "Success") {
      // A workspace that moved mid-request is asked again on the next refresh.
      if (pullRequestKey.current === key) pullRequestKey.current = null;
      return;
    }
    setPullRequests(
      new Map(
        result.value.revisions.map((revision) => [
          revision.bookmark,
          {
            url: revision.summary.url,
            number: revision.summary.number,
            state: revision.summary.state,
          },
        ]),
      ),
    );
  };
  const readRemoteHead = async (next: JjPanelReady, request: number) => {
    const { bookmark, remote } = jjGitActionsState({
      rows: next.rows,
      workingCopyCommitId: next.workingCopyCommitId,
      remotes: next.remotes,
    });
    if (!bookmark || !remote) return;
    const result = await getPanel({
      environmentId,
      input: { cwd, ...jjRemoteBookmarkView({ bookmark, remote }) },
    });
    if (request !== generation.current || !AsyncResult.isSuccess(result)) return;
    if (result.value.status !== "ready") return;
    // The panel always lists the working copy too, so a remote head on `@` itself reads as none.
    const workingCopyCommitId = result.value.workingCopyCommitId;
    const head = result.value.rows.find((row) => row.commitId !== workingCopyCommitId);
    setRemoteHead({ bookmark, commitId: head?.commitId ?? null });
  };
  const refreshFromEffect = useEffectEvent(() => void refresh());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads jj state when the checkout's Git status moves or the window regains focus
  useEffect(() => {
    // Waits for the first status so a checkout that is not a repository never asks jj.
    if (!enabled || gitStatus === null) return;
    const timer = setTimeout(refreshFromEffect, 300);
    window.addEventListener("focus", refreshFromEffect);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refreshFromEffect);
    };
  }, [enabled, gitStatus]);

  if (!enabled || notJj || panel === null) return props.render(true);

  const state = jjGitActionsState({
    rows: panel.rows,
    workingCopyCommitId: panel.workingCopyCommitId,
    remotes: panel.remotes,
    remoteHead: remoteHead ?? undefined,
  });
  const canCreatePullRequest =
    capabilities.jjPanelForge === true && canPublish && projectId !== null;
  // Kept per bookmark name: committing and pushing move the bookmark, not the pull request.
  const topPullRequest = state.bookmark ? pullRequests.get(state.bookmark) : undefined;
  const openPullRequest = topPullRequest?.state === "open" ? topPullRequest : null;
  const stackPublished = state.stackBookmarks.every(
    (name) => pullRequests.get(name)?.state === "open",
  );
  const quickAction = jjQuickAction({
    state,
    canCreatePullRequest,
    hasPullRequest: openPullRequest !== null,
    stackPublished,
  });
  const labels: Record<JjGitAction, string> = {
    commit: gt("Commit"),
    push: gt("Push"),
    "create-pr": gt("Create PR"),
    "view-pr": openPullRequest ? gt("View PR #{number}", { number: openPullRequest.number }) : "",
    "publish-stack": gt("Publish stack"),
  };
  const blockerText = (action: JjGitAction) => {
    if (action === "view-pr") return null;
    if (action === "publish-stack" && !canCreatePullRequest)
      return gt("Pull requests need a GitHub or GitLab remote and permission to publish.");
    if (action === "create-pr" && !canCreatePullRequest)
      return gt("Pull requests need a GitHub or GitLab remote and permission to publish.");
    switch (jjGitActionBlocker(state, action)) {
      case "clean":
        return gt("The working copy has no changes to commit.");
      case "no-target":
        return gt("Nothing to publish: commit or describe a change first.");
      case "no-bookmark":
        return gt("No bookmark marks this work. Set one in the Jujutsu panel.");
      case "no-remote":
        return gt("This repository has no remote.");
      case "pushed":
        return gt("The remote bookmark is already up to date.");
      case "no-base":
        return gt("Trunk has no bookmark on the remote to target.");
      case "no-stack":
        return gt("Bookmark at least two changes to publish them as a stack.");
      case null:
        return null;
    }
  };

  const toastError = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description }));

  const run = async (action: JjRunAction, current: JjPanelReady) => {
    const result = await runAction({
      environmentId,
      input: {
        cwd,
        workspaceIdentity: current.workspaceIdentity,
        expectedOperationId: current.operationId,
        view: JJ_GIT_ACTIONS_VIEW,
        action,
      },
    });
    if (result._tag !== "Success") throw new Error(formatJjPanelError(result.cause));
    accept(result.value.panel);
    return result.value.panel;
  };

  /** Brings the bookmark up to the target, so what gets pushed is the committed work. */
  const placeBookmark = async () => {
    if (!state.needsMove || !state.target || !state.bookmark) return panel;
    return run(
      { type: "bookmark-set", name: state.bookmark, revisionCommitId: state.target.commitId },
      panel,
    );
  };

  const push = async () => {
    if (!state.bookmark || !state.remote) return;
    const current = await placeBookmark();
    await run({ type: "push", bookmarkNames: [state.bookmark], remote: state.remote }, current);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Pushed {bookmark}", { bookmark: state.bookmark }),
      }),
    );
  };

  const createPullRequest = async () => {
    const { target, bookmark, baseBookmark, remote } = state;
    if (!target || !bookmark || !baseBookmark || !remote || projectId === null) return;
    const current = await placeBookmark();
    const preview = await forgePreview({
      environmentId,
      input: {
        cwd,
        workspaceIdentity: current.workspaceIdentity,
        expectedOperationId: current.operationId,
        projectId,
        remote,
        mode: "single",
        baseBookmark,
        selections: [{ commitId: target.commitId, bookmark }],
      },
    });
    if (preview._tag !== "Success")
      throw new Error(jjForgeFailureMessage(squashAtomCommandFailure(preview)));
    const published = await forgePublish({
      environmentId,
      input: { ...preview.value.input, expectedDestination: preview.value.destination },
    });
    if (published._tag !== "Success")
      throw new Error(jjForgeFailureMessage(squashAtomCommandFailure(published)));
    const layer = published.value.layers[0];
    if (!layer) return;
    setPullRequests(
      (current) =>
        new Map([
          ...current,
          [bookmark, { url: layer.url, number: layer.reference.number, state: "open" }],
        ]),
    );
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: layer.created ? gt("Pull request created") : gt("Pull request updated"),
        description: layer.url,
      }),
    );
    void openLink(layer.url).catch(() => undefined);
  };

  /** Pushes every layer's bookmark, then links them into one GitHub stack of pull requests. */
  const publishStack = async () => {
    const { remote, baseBookmark, stackBookmarks } = state;
    if (!remote || !baseBookmark || stackBookmarks.length < 2) return;
    const current = await placeBookmark();
    await run({ type: "push", bookmarkNames: [...stackBookmarks], remote }, current);
    const result = await stackLink({
      environmentId,
      input: { cwd, remote, baseBookmark, bookmarks: [...stackBookmarks] },
    });
    if (result._tag !== "Success") throw new Error(formatJjPanelError(result.cause));
    pullRequestKey.current = null;
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Stack published"),
        description: result.value.output || stackBookmarks.join(" → "),
      }),
    );
  };

  const start = async (action: JjGitAction) => {
    if (action === "commit") {
      setCommitError(null);
      setCommitting(true);
      return;
    }
    if (action === "view-pr") {
      if (openPullRequest) void openLink(openPullRequest.url).catch(() => undefined);
      return;
    }
    if (running) return;
    setRunning(action);
    try {
      await (action === "push"
        ? push()
        : action === "publish-stack"
          ? publishStack()
          : createPullRequest());
    } catch (error) {
      toastError(
        action === "push"
          ? gt("Push failed")
          : action === "publish-stack"
            ? gt("Stack publication failed")
            : gt("Pull request failed"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRunning(null);
      void refresh();
    }
  };

  const primary = running ?? quickAction ?? "push";
  const PrimaryIcon = ICONS[primary];
  const primaryBlocked = running === null && quickAction === null;
  const hidden = props.compact === true && running === null;

  return (
    <>
      {hidden ? null : (
        <div
          role="group"
          aria-label={gt("Jujutsu actions for {name}", { name: props.target?.name ?? "" })}
          ref={anchorRef}
          className={cn("shrink-0", THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS)}
        >
          <ThreadDetailsControl
            data-toolbar-control=""
            variant="ghost"
            size="xs"
            part="primary"
            panel
            title={primaryBlocked ? (blockerText("push") ?? undefined) : undefined}
            disabled={!canRun || running !== null || primaryBlocked}
            onClick={() => void start(primary)}
          >
            <PrimaryIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className={cn("not-sr-only ml-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              {running ? gt("{action}…", { action: labels[running] }) : labels[primary]}
            </span>
          </ThreadDetailsControl>
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          <Menu onOpenChange={(open) => open && void refresh()}>
            <MenuTrigger
              disabled={running !== null}
              render={
                <ThreadDetailsControl
                  aria-label={gt("Jujutsu action options")}
                  data-toolbar-control=""
                  size="sm"
                  variant="ghost"
                  part="secondary"
                  panel
                />
              }
            >
              <ChevronDownIcon aria-hidden className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
            </MenuTrigger>
            <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
              {(
                [
                  "commit",
                  "push",
                  ...(state.stack.length > 1 ? (["publish-stack"] as const) : []),
                  openPullRequest ? "view-pr" : "create-pr",
                ] as const
              ).map((action) => {
                const Icon = ICONS[action];
                const blocker = blockerText(action);
                return (
                  <MenuItem
                    key={action}
                    disabled={!canRun || blocker !== null}
                    title={blocker ?? undefined}
                    onClick={() => void start(action)}
                  >
                    <Icon aria-hidden />
                    <MenuItemLabel>{labels[action]}</MenuItemLabel>
                  </MenuItem>
                );
              })}
              {state.bookmark ? (
                <p className="px-2 py-1.5 text-muted-foreground text-xs">
                  {state.target === null
                    ? gt("Commit the working copy first; Push then moves {bookmark} onto it.", {
                        bookmark: state.bookmark,
                      })
                    : state.needsMove
                      ? gt("Moves {bookmark} to the latest described change before publishing.", {
                          bookmark: state.bookmark,
                        })
                      : gt("Publishes bookmark {bookmark}.", { bookmark: state.bookmark })}
                </p>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      )}
      {!hidden && state.stack.length > 1 ? (
        <section aria-label={gt("Stack")} className="flex flex-col py-1 text-xs">
          <span className="px-2.5 pb-0.5 text-muted-foreground">{gt("Stack")}</span>
          <ol className="flex flex-col">
            {state.stack.toReversed().map((entry) => {
              const pullRequest = entry.bookmark ? pullRequests.get(entry.bookmark) : undefined;
              return (
                <li
                  key={entry.row.commitId}
                  className="flex h-7 min-w-0 items-center gap-1.5 ps-2.5 pe-1"
                >
                  <span className="min-w-0 flex-1 truncate">{entry.row.summary}</span>
                  {entry.bookmark ? (
                    <span className="max-w-28 shrink-0 truncate font-mono text-muted-foreground">
                      {entry.bookmark}
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={!canRun || running !== null}
                      onClick={() => {
                        setBookmarkError(null);
                        setBookmarking({
                          revision: entry.row,
                          suggestedName: jjNextBookmarkName({
                            base: state.bookmark ?? state.stackBookmarks[0] ?? "stack",
                            taken: panel.rows.flatMap((row) => row.bookmarks ?? []),
                          }),
                        });
                      }}
                    >
                      <BookmarkPlusIcon aria-hidden />
                      {gt("Bookmark")}
                    </Button>
                  )}
                  {pullRequest ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      title={pullRequest.url}
                      onClick={() => void openLink(pullRequest.url).catch(() => undefined)}
                    >
                      {pullRequest.state === "open"
                        ? gt("#{number}", { number: pullRequest.number })
                        : pullRequest.state === "merged"
                          ? gt("#{number} merged", { number: pullRequest.number })
                          : gt("#{number} closed", { number: pullRequest.number })}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {bookmarking ? (
        <JjActionDialog
          request={{
            kind: "bookmark",
            mode: "set",
            revision: bookmarking.revision,
            suggestedName: bookmarking.suggestedName,
          }}
          environmentId={environmentId}
          cwd={cwd}
          rows={panel.rows}
          remotes={panel.remotes}
          busy={running !== null}
          error={bookmarkError}
          onCancel={() => setBookmarking(null)}
          onConfirm={(action) => {
            void run(action, panel)
              .then(() => setBookmarking(null))
              .catch((error: unknown) =>
                setBookmarkError(error instanceof Error ? error.message : String(error)),
              );
          }}
        />
      ) : null}
      {committing && state.workingCopy ? (
        <JjActionDialog
          request={{ kind: "commit", revision: state.workingCopy }}
          environmentId={environmentId}
          cwd={cwd}
          rows={panel.rows}
          remotes={panel.remotes}
          busy={running !== null}
          error={commitError}
          onCancel={() => setCommitting(false)}
          onGenerateCommitMessage={
            canGenerate
              ? async () => {
                  const result = await generateCommitMessage({
                    environmentId,
                    input: { cwd, ...(projectId !== null ? { projectId } : {}) },
                  });
                  if (result._tag !== "Success") throw new Error(formatJjPanelError(result.cause));
                  return result.value.message;
                }
              : undefined
          }
          onConfirm={(action) => {
            setRunning("commit");
            void run(action, panel)
              .then(() => setCommitting(false))
              .catch((error: unknown) =>
                setCommitError(error instanceof Error ? error.message : String(error)),
              )
              .finally(() => setRunning(null));
          }}
        />
      ) : null}
      {props.render(false)}
    </>
  );
};
