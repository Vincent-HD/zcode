import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  JjActionReceipt,
  JjMutationResult,
  JjPanelReady,
  JjPanelSnapshot,
  JjRevision,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowDown,
  Bookmark,
  ChevronsDown,
  Combine,
  Trash2,
  Undo2,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  RefreshCw,
  Tag,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useEnvironmentScope } from "~/state/session";
import { useServerConfigs } from "~/state/entities";
import { jjEnvironment } from "~/state/jj";
import { useAtomCommand } from "~/state/use-atom-command";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "~/components/ui/menu";
import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import {
  descriptionDraftIsStale,
  reconcileDescriptionDrafts,
  otherLoadedJjRevisions,
  formatJjPanelError,
  visibleJjRevisions,
  reconcileJjSelection,
  jjActionContextIsCurrent,
  jjActionLabels,
  jjSquashTargets,
  jjFileActionPaths,
  type DescriptionDraft,
  type JjPanelActionKind,
} from "./jj-panel-state";
import {
  emptyJjDescriptionDrafts,
  jjDescriptionDraftScopeKey,
  useJjDescriptionDraftStore,
} from "./jj-description-draft-store";
import { JjActionDialog, jjTargetRevisions, type JjActionPreview } from "./jj-action-dialog";
import type { JjDiffContext } from "~/diffPanelStore";
import type { ProjectId } from "@t3tools/contracts";
import { JjForgePanel } from "./jj-forge-panel";
import type { JjForgeSectionProps } from "./JjForgeSection";

const rowActions: JjPanelActionKind[] = [
  "new",
  "commit",
  "edit",
  "insert-before",
  "insert-after",
  "squash-into",
  "squash-onto",
  "absorb",
  "rebase-revision",
  "rebase-branch",
  "duplicate",
  "merge",
  "abandon",
  "restore",
  "bookmark-set",
  "bookmark-advance",
  "bookmark-delete",
  "push",
];
const workspaceKey = (panel: JjPanelReady) => JSON.stringify(panel.workspaceIdentity);

const refPillStyles = {
  bookmark: "border-info/50 bg-info/10 text-info",
  remote: "border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-300/90",
  tag: "border-success/50 bg-success/10 text-success",
};

const RefPill = (props: { kind: keyof typeof refPillStyles; label: string }) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <span
          className={`inline-flex h-4 min-w-0 shrink items-center gap-0.5 rounded-full border px-1.5 text-2xs ${refPillStyles[props.kind]}`}
        />
      }
    >
      {props.kind === "tag" ? (
        <Tag aria-hidden="true" className="size-2.5 shrink-0" />
      ) : (
        <Bookmark aria-hidden="true" className="size-2.5 shrink-0" />
      )}
      <span className="truncate">{props.label}</span>
    </TooltipTrigger>
    <TooltipPopup>{props.label}</TooltipPopup>
  </Tooltip>
);

const RevisionRefPills = (props: { revision: JjRevision }) => {
  const pills = [
    ...(props.revision.bookmarks ?? []).map((label) => ({ kind: "bookmark" as const, label })),
    ...(props.revision.remoteBookmarks ?? []).map((label) => ({ kind: "remote" as const, label })),
    ...(props.revision.tags ?? []).map((label) => ({ kind: "tag" as const, label })),
  ];
  if (pills.length === 0) return null;
  return (
    <span className="flex min-w-0 max-w-[50%] shrink items-center gap-1 overflow-hidden">
      {pills.map((pill) => (
        <RefPill key={`${pill.kind}:${pill.label}`} kind={pill.kind} label={pill.label} />
      ))}
    </span>
  );
};

const JjPanel = (props: {
  environmentId: EnvironmentId;
  cwd: string | null;
  visible: boolean;
  projectId?: ProjectId | undefined;
  onOpenPullRequest?: JjForgeSectionProps["onOpenPullRequest"];
  onOpenDiff?: (revisionCommitId: string, filePath: string, context?: JjDiffContext) => void;
}) => {
  const getPanel = useAtomCommand(jjEnvironment.getPanel, {
    reportFailure: false,
    reportDefect: false,
  });
  const describe = useAtomCommand(jjEnvironment.describe, {
    reportFailure: false,
    reportDefect: false,
  });
  const runAction = useAtomCommand(jjEnvironment.runAction, {
    reportFailure: false,
    reportDefect: false,
  });
  const revert = useAtomCommand(jjEnvironment.revertOperation, {
    reportFailure: false,
    reportDefect: false,
  });
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const serverConfig = useServerConfigs().get(props.environmentId);
  const supportsPanel = serverConfig?.environment.capabilities.jjPanel === true;
  const supportsActions = serverConfig?.environment.capabilities.jjPanelActions === true;
  const supportsDiff = serverConfig?.environment.capabilities.jjPanelDiff === true;
  const canDescribe = useAtomValue(jjEnvironment.describe.permissionAtom(props.environmentId));
  const actionPermission = useAtomValue(
    jjEnvironment.runAction.permissionAtom(props.environmentId),
  );
  const canAct = supportsActions && actionPermission;
  const canDiff = useAtomValue(jjEnvironment.getDiff.permissionAtom(props.environmentId));
  const canRevert = useAtomValue(jjEnvironment.revertOperation.permissionAtom(props.environmentId));
  const contextKey = JSON.stringify([props.environmentId, props.cwd]);
  const [snapshot, setSnapshot] = useState<JjPanelSnapshot | null>(null);
  const [snapshotContext, setSnapshotContext] = useState<string | null>(null);
  const draftScopeKey =
    snapshotContext === contextKey && snapshot?.status === "ready" && props.cwd
      ? jjDescriptionDraftScopeKey({
          environmentId: props.environmentId,
          cwd: props.cwd,
          workspaceIdentity: snapshot.workspaceIdentity,
        })
      : null;
  const drafts = useJjDescriptionDraftStore((state) =>
    draftScopeKey
      ? (state.draftsByScope[draftScopeKey] ?? emptyJjDescriptionDrafts)
      : emptyJjDescriptionDrafts,
  );
  const setDrafts = (
    update: (
      current: Readonly<Record<string, DescriptionDraft>>,
    ) => Readonly<Record<string, DescriptionDraft>>,
  ) => {
    if (draftScopeKey)
      useJjDescriptionDraftStore.getState().setDrafts({ scopeKey: draftScopeKey, update });
  };
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const [detailsExpansion, setDetailsExpansion] = useState<Record<string, boolean>>({});
  const [editingChangeId, setEditingChangeId] = useState<string | null>(null);
  const [selectedCommitIds, setSelectedCommitIds] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Record<string, string[]>>({});
  const { resolvedTheme } = useTheme();
  const [receipt, setReceipt] = useState<JjActionReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [preview, setPreview] = useState<JjActionPreview | null>(null);
  const [revertReceipt, setRevertReceipt] = useState<JjActionReceipt | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const mutationBusy = useRef(false);
  const identity = useRef<string | null>(null);
  const mounted = useRef(false);

  // Tracks the component lifetime so async Jujutsu actions ignore replies after unmount.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the component lifetime for async reply guards
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const acceptSnapshot = (next: JjPanelSnapshot) => {
    setSnapshot(next);
    setSnapshotContext(contextKey);
    if (next.status !== "ready") {
      identity.current = null;
      setSelectedCommitIds([]);
      setSelectedPaths({});
      return;
    }
    const nextIdentity = workspaceKey(next);
    const sameWorkspace = identity.current === nextIdentity;
    identity.current = nextIdentity;
    const revisions = jjTargetRevisions(next);
    if (props.cwd)
      useJjDescriptionDraftStore.getState().setDrafts({
        scopeKey: jjDescriptionDraftScopeKey({
          environmentId: props.environmentId,
          cwd: props.cwd,
          workspaceIdentity: next.workspaceIdentity,
        }),
        update: (current) => reconcileDescriptionDrafts({ drafts: current, revisions }),
      });
    setSelectedCommitIds((current) =>
      sameWorkspace
        ? reconcileJjSelection({
            selectedCommitIds: current,
            revisions,
          })
        : [],
    );
    setSelectedPaths((current) =>
      Object.fromEntries(
        revisions.map((revision) => [
          revision.commitId,
          sameWorkspace
            ? (current[revision.commitId] ?? []).filter((path) =>
                revision.files.some((file) => file.path === path),
              )
            : [],
        ]),
      ),
    );
    if (!sameWorkspace) {
      setReceipt(null);
      setExpansion({});
      setDetailsExpansion({});
      setEditingChangeId(null);
    }
  };

  const refresh = async () => {
    if (
      !active.current ||
      !props.cwd ||
      !canRead ||
      !supportsPanel ||
      mutationBusy.current ||
      document.visibilityState === "hidden"
    )
      return;
    const requestGeneration = ++generation.current;
    setLoading(true);
    const result = await getPanel({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    });
    if (!active.current || generation.current !== requestGeneration) return;
    setLoading(false);
    if (AsyncResult.isSuccess(result)) {
      acceptSnapshot(result.value);
      setError(null);
      return;
    }
    if (result._tag === "Failure") setError(formatJjPanelError(result.cause));
  };
  const refreshFromEffect = useEffectEvent(refresh);

  // Refreshes when the panel becomes available and when the window or document regains focus.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- manages refresh requests across access and focus changes while shown
  useEffect(() => {
    active.current = props.visible;
    if (!props.visible || !canRead || !supportsPanel) {
      generation.current++;
      return;
    }
    queueMicrotask(() => refreshFromEffect());
    const onFocus = () => {
      if (document.visibilityState === "hidden") {
        generation.current++;
        setLoading(false);
        return;
      }
      refreshFromEffect();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      active.current = false;
      generation.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [props.visible, canRead, supportsPanel]);

  const mutate = async (input: {
    run: () => Promise<AsyncResult.AsyncResult<JjMutationResult, unknown>>;
    title: string;
    savedChangeId?: string;
  }) => {
    if (!active.current || !supportsPanel || mutationBusy.current) return;
    const savedDraft = input.savedChangeId ? drafts[input.savedChangeId] : undefined;
    mutationBusy.current = true;
    ++generation.current;
    setMutating(true);
    setLoading(false);
    const result = await input.run();
    mutationBusy.current = false;
    if (AsyncResult.isSuccess(result) && input.savedChangeId && draftScopeKey) {
      useJjDescriptionDraftStore.getState().clearSavedDraft({
        scopeKey: draftScopeKey,
        changeId: input.savedChangeId,
        savedDraft,
      });
    }
    if (!mounted.current) return;
    setMutating(false);
    if (AsyncResult.isSuccess(result)) {
      acceptSnapshot(result.value.panel);
      setReceipt(result.value.receipt);
      setPreview(null);
      setRevertReceipt(null);
      setEditingChangeId(null);
      setSelectedCommitIds([]);
      setSelectedPaths({});
      setError(null);
      if (active.current) toastManager.add({ type: "success", title: input.title });
      void refresh();
      return;
    }
    if (result._tag === "Failure") {
      const message = formatJjPanelError(result.cause);
      setError(message);
      if (active.current)
        toastManager.add({ type: "error", title: "Jujutsu action failed", description: message });
      void refresh();
    }
  };

  const panel =
    supportsPanel && canRead && snapshotContext === contextKey && snapshot?.status === "ready"
      ? snapshot
      : null;
  const loadedRevisions = panel ? jjTargetRevisions(panel) : [];
  const rows = panel ? visibleJjRevisions(panel) : [];
  const otherRows = panel
    ? otherLoadedJjRevisions({ revisions: loadedRevisions, visibleRevisions: rows })
    : [];
  const source = rows[0];
  const currentDraft = source ? drafts[source.changeId] : undefined;
  const dirtyWorkingCopy = Boolean(
    currentDraft && currentDraft.text !== currentDraft.baseDescription,
  );
  const blocked =
    mutating || loading || !props.visible || !supportsPanel || !canRead || Boolean(error);
  const previewStale = Boolean(
    preview &&
    (preview.environmentId !== props.environmentId ||
      preview.cwd !== props.cwd ||
      !jjActionContextIsCurrent({ captured: preview.panel, current: panel })),
  );
  const undoAvailable = Boolean(
    panel && receipt?.undoAvailable && panel.operationId === receipt.operationId,
  );
  const openAction = (
    kind: JjPanelActionKind,
    revision: JjRevision,
    options?: {
      paths?: string[];
      squashScope?: "parent" | "ancestors";
      onlyRevision?: boolean;
      useSelection?: boolean;
    },
  ) => {
    if (!panel || !props.cwd || blocked || !canAct || dirtyWorkingCopy) return;
    setRevertReceipt(null);
    setPreview({
      environmentId: props.environmentId,
      cwd: props.cwd,
      panel,
      kind,
      source: revision,
      selectedCommitIds:
        options?.useSelection ||
        (!options?.onlyRevision && selectedCommitIds.includes(revision.commitId))
          ? selectedCommitIds
          : [revision.commitId],
      paths: options?.paths ?? selectedPaths[revision.commitId] ?? [],
      ...(options?.squashScope ? { squashScope: options.squashScope } : {}),
    });
  };
  const copyId = (value: string) => {
    void writeTextToClipboard(value, "Jujutsu ID").then(
      () => toastManager.add({ type: "success", title: "ID copied" }),
      () => toastManager.add({ type: "error", title: "Could not copy ID" }),
    );
  };

  const renderRevision = (revision: JjRevision) => {
    if (!panel) return null;
    const current = revision.commitId === panel.workingCopyCommitId;
    const expanded = expansion[revision.changeId] ?? current;
    const editing = editingChangeId === revision.changeId;
    const draft = drafts[revision.changeId];
    const dirty = Boolean(draft && draft.text !== draft.baseDescription);
    const stale = Boolean(draft && descriptionDraftIsStale({ draft, revision }));
    const filesSelected = selectedPaths[revision.commitId] ?? [];
    const showDetails = detailsExpansion[revision.changeId] ?? false;
    const actionDisabled = (kind: JjPanelActionKind) =>
      blocked ||
      !canAct ||
      dirtyWorkingCopy ||
      (revision.immutable &&
        [
          "commit",
          "edit",
          "insert-before",
          "squash-into",
          "squash-onto",
          "absorb",
          "rebase-revision",
          "rebase-branch",
          "abandon",
          "restore",
        ].includes(kind)) ||
      (revision.conflict &&
        [
          "commit",
          "insert-before",
          "insert-after",
          "squash-into",
          "squash-onto",
          "absorb",
          "rebase-revision",
          "rebase-branch",
          "duplicate",
          "merge",
        ].includes(kind));
    const hasSquashParent =
      jjSquashTargets({ source: revision, revisions: loadedRevisions, scope: "parent" }).length > 0;
    const hasSquashAncestor =
      jjSquashTargets({ source: revision, revisions: loadedRevisions, scope: "ancestors" }).length >
      0;
    const quickButton = (input: {
      label: string;
      icon: ReactNode;
      disabled: boolean;
      onClick: () => void;
    }) => (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={input.label}
              disabled={input.disabled}
              onClick={input.onClick}
            />
          }
        >
          {input.icon}
        </TooltipTrigger>
        <TooltipPopup>{input.label}</TooltipPopup>
      </Tooltip>
    );
    return (
      <section key={revision.changeId} className="border-b border-border/50 last:border-b-0">
        <div className="group flex h-8 items-center gap-1">
          <Checkbox
            aria-label={`Select revision ${revision.changeId.slice(0, 8)}`}
            checked={selectedCommitIds.includes(revision.commitId)}
            disabled={mutating}
            onCheckedChange={(checked) =>
              setSelectedCommitIds((ids) =>
                checked
                  ? [...ids, revision.commitId]
                  : ids.filter((id) => id !== revision.commitId),
              )
            }
          />
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring"
            aria-expanded={expanded}
            aria-controls={`jj-details-${revision.changeId}`}
            onClick={() =>
              setExpansion((previous) => ({
                ...previous,
                [revision.changeId]: !expanded,
              }))
            }
          >
            {expanded ? (
              <ChevronDown className="size-4 shrink-0" />
            ) : (
              <ChevronRight className="size-4 shrink-0" />
            )}
            {current && <span className="shrink-0 font-medium">@</span>}
            <span className="shrink-0 font-mono text-muted-foreground">
              {revision.changeId.slice(0, 8)}
            </span>
            <span className="truncate">
              {revision.description.split("\n")[0] || "(no description)"}
              {dirty ? (stale ? " · stale draft" : " · unsaved draft") : ""}
            </span>
          </button>
          <RevisionRefPills revision={revision} />
          {revision.conflict && <span className="text-2xs text-destructive">Conflict</span>}
          {revision.immutable && <span className="text-2xs text-muted-foreground">Immutable</span>}
          <span
            className="text-2xs tabular-nums text-muted-foreground"
            aria-label={`${revision.files.length} changed files`}
          >
            {revision.files.length}
            {panel.filesTruncated ? "+" : ""}
          </span>
          <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {quickButton({
              label: "Absorb revision changes",
              icon: <Combine />,
              disabled: actionDisabled("absorb"),
              onClick: () => openAction("absorb", revision, { paths: [], onlyRevision: true }),
            })}
            {quickButton({
              label: "Abandon revision",
              icon: <Trash2 />,
              disabled: actionDisabled("abandon"),
              onClick: () => openAction("abandon", revision, { onlyRevision: true }),
            })}
            {quickButton({
              label: "Squash revision into ancestor",
              icon: <ChevronsDown />,
              disabled: actionDisabled("squash-into") || !hasSquashAncestor,
              onClick: () =>
                openAction("squash-into", revision, {
                  paths: [],
                  squashScope: "ancestors",
                  onlyRevision: true,
                }),
            })}
            {quickButton({
              label: "Squash revision into parent",
              icon: <ArrowDown />,
              disabled: actionDisabled("squash-into") || !hasSquashParent,
              onClick: () =>
                openAction("squash-into", revision, {
                  paths: [],
                  squashScope: "parent",
                  onlyRevision: true,
                }),
            })}
          </div>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${revision.changeId.slice(0, 8)}`}
                  disabled={blocked}
                />
              }
            >
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() => {
                  setDetailsExpansion((previous) => ({
                    ...previous,
                    [revision.changeId]: !showDetails,
                  }));
                  setExpansion((previous) => ({ ...previous, [revision.changeId]: true }));
                }}
              >
                {showDetails ? "Hide revision details" : "Show revision details"}
              </MenuItem>
              <MenuItem
                disabled={!canDescribe || revision.immutable || mutating}
                onClick={() => {
                  setEditingChangeId(revision.changeId);
                  setExpansion((previous) => ({
                    ...previous,
                    [revision.changeId]: true,
                  }));
                }}
              >
                Edit description
              </MenuItem>
              <MenuSeparator />
              {rowActions
                .filter((kind) => kind !== "commit" || current)
                .map((kind) => (
                  <MenuItem
                    key={kind}
                    variant={
                      kind === "abandon" || kind === "restore" || kind === "bookmark-delete"
                        ? "destructive"
                        : "default"
                    }
                    disabled={actionDisabled(kind)}
                    onClick={() => openAction(kind, revision)}
                  >
                    {jjActionLabels[kind]}…
                  </MenuItem>
                ))}
            </MenuPopup>
          </Menu>
        </div>
        {expanded && (
          <div id={`jj-details-${revision.changeId}`} className="space-y-2 pb-2 pl-5 text-xs">
            {showDetails && (
              <div className="space-y-1 text-muted-foreground">
                <div className="flex min-w-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger render={<span className="min-w-0 truncate font-mono" />}>
                      Change: {revision.changeId}
                    </TooltipTrigger>
                    <TooltipPopup>{revision.changeId}</TooltipPopup>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Copy change ID"
                    onClick={() => copyId(revision.changeId)}
                  >
                    <Copy />
                  </Button>
                </div>
                <div className="flex min-w-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger render={<span className="min-w-0 truncate font-mono" />}>
                      Commit: {revision.commitId}
                    </TooltipTrigger>
                    <TooltipPopup>{revision.commitId}</TooltipPopup>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Copy commit ID"
                    onClick={() => copyId(revision.commitId)}
                  >
                    <Copy />
                  </Button>
                </div>
                {revision.author && (
                  <p className="break-words">
                    Author: {revision.author.name} &lt;{revision.author.email}&gt; ·{" "}
                    <time dateTime={revision.author.timestamp}>{revision.author.timestamp}</time>
                  </p>
                )}
                {revision.committer && (
                  <p className="break-words">
                    Committer: {revision.committer.name} ·{" "}
                    <time dateTime={revision.committer.timestamp}>
                      {revision.committer.timestamp}
                    </time>
                  </p>
                )}
                <p className="break-words">Bookmarks: {revision.bookmarks?.join(", ") || "none"}</p>
                <p className="break-words">
                  Remote bookmarks: {revision.remoteBookmarks?.join(", ") || "none"}
                </p>
                <p className="break-words">Tags: {revision.tags?.join(", ") || "none"}</p>
              </div>
            )}
            {editing ? (
              <div className="space-y-2">
                <Textarea
                  size="sm"
                  autoFocus
                  aria-label={`Description for ${revision.changeId.slice(0, 8)}`}
                  value={draft?.text ?? revision.description}
                  disabled={revision.immutable || !canDescribe || mutating}
                  onChange={(event) => {
                    const text = event.target.value;
                    setDrafts((currentDrafts) => ({
                      ...currentDrafts,
                      [revision.changeId]: {
                        ...(currentDrafts[revision.changeId] ?? {
                          baseDescription: revision.description,
                          baseCommitId: revision.commitId,
                        }),
                        text,
                      },
                    }));
                  }}
                />
                {stale && (
                  <p className="text-warning-foreground">
                    This revision changed outside the editor. Your draft is retained; cancel to load
                    its current description.
                  </p>
                )}
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={blocked || !canDescribe || revision.immutable || !dirty || stale}
                    onClick={() => {
                      const cwd = props.cwd;
                      if (!draft || !cwd || stale || !canDescribe || blocked) return;
                      void mutate({
                        title: "Revision described",
                        savedChangeId: revision.changeId,
                        run: () =>
                          describe({
                            environmentId: props.environmentId,
                            input: {
                              cwd,
                              workspaceIdentity: panel.workspaceIdentity,
                              expectedOperationId: panel.operationId,
                              revisionCommitId: revision.commitId,
                              description: draft.text,
                            },
                          }),
                      });
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={mutating}
                    onClick={() => {
                      setDrafts((currentDrafts) => ({
                        ...currentDrafts,
                        [revision.changeId]: {
                          text: revision.description,
                          baseDescription: revision.description,
                          baseCommitId: revision.commitId,
                        },
                      }));
                      setEditingChangeId(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {showDetails && revision.description.includes("\n") && (
                  <p className="whitespace-pre-wrap break-words">{revision.description}</p>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={blocked || !canDescribe || revision.immutable}
                  onClick={() => setEditingChangeId(revision.changeId)}
                >
                  {dirty ? "Resume description draft" : "Edit description"}
                </Button>
              </>
            )}
            <ul className="space-y-0.5">
              {revision.files.map((file) => (
                <li
                  key={file.path}
                  className="group flex h-7 min-w-0 items-center gap-2 rounded hover:bg-accent/50"
                >
                  <Checkbox
                    aria-label={`Select ${file.path}`}
                    checked={filesSelected.includes(file.path)}
                    disabled={mutating}
                    onCheckedChange={(checked) =>
                      setSelectedPaths((paths) => ({
                        ...paths,
                        [revision.commitId]: checked
                          ? [...filesSelected, file.path]
                          : filesSelected.filter((path) => path !== file.path),
                      }))
                    }
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                          disabled={!props.onOpenDiff || blocked || !supportsDiff || !canDiff}
                          onClick={() =>
                            props.onOpenDiff?.(revision.commitId, file.path, {
                              workspaceIdentity: panel.workspaceIdentity,
                              expectedOperationId: panel.operationId,
                            })
                          }
                        />
                      }
                    >
                      <PierreEntryIcon pathValue={file.path} kind="file" theme={resolvedTheme} />
                      <span className="truncate">{file.path}</span>
                    </TooltipTrigger>
                    <TooltipPopup>
                      {file.path} · {file.status}
                    </TooltipPopup>
                  </Tooltip>
                  <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    {quickButton({
                      label: "Restore file(s)",
                      icon: <Undo2 />,
                      disabled: actionDisabled("restore"),
                      onClick: () =>
                        openAction("restore", revision, {
                          paths: jjFileActionPaths({
                            path: file.path,
                            selectedPaths: filesSelected,
                          }),
                          onlyRevision: true,
                        }),
                    })}
                    {quickButton({
                      label: "Squash file(s) into ancestor",
                      icon: <ChevronsDown />,
                      disabled: actionDisabled("squash-into") || !hasSquashAncestor,
                      onClick: () =>
                        openAction("squash-into", revision, {
                          paths: jjFileActionPaths({
                            path: file.path,
                            selectedPaths: filesSelected,
                          }),
                          squashScope: "ancestors",
                          onlyRevision: true,
                        }),
                    })}
                    {quickButton({
                      label: "Squash file(s) into parent",
                      icon: <ArrowDown />,
                      disabled: actionDisabled("squash-into") || !hasSquashParent,
                      onClick: () =>
                        openAction("squash-into", revision, {
                          paths: jjFileActionPaths({
                            path: file.path,
                            selectedPaths: filesSelected,
                          }),
                          squashScope: "parent",
                          onlyRevision: true,
                        }),
                    })}
                  </div>
                  {revision.conflictPaths?.includes(file.path) && (
                    <span className="shrink-0 text-destructive">Conflict</span>
                  )}
                  <span
                    className={
                      file.status === "added"
                        ? "text-diff-addition-foreground"
                        : file.status === "removed"
                          ? "text-destructive"
                          : "text-warning-foreground"
                    }
                    aria-label={file.status}
                  >
                    {
                      {
                        added: "A",
                        modified: "M",
                        removed: "D",
                        renamed: "R",
                        copied: "C",
                      }[file.status]
                    }
                  </span>
                </li>
              ))}
              {revision.files.length === 0 && (
                <li className="py-1 text-muted-foreground">No changed files</li>
              )}
            </ul>
            {(revision.conflictPaths ?? [])
              .filter((path) => !revision.files.some((file) => file.path === path))
              .map((path) => (
                <p key={path} className="break-all text-destructive">
                  Conflict · {path}
                </p>
              ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="text-xs font-semibold text-muted-foreground">
          CHANGES{selectedCommitIds.length ? ` · ${selectedCommitIds.length} selected` : ""}
        </span>
        <div className="flex shrink-0 gap-1">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Workspace actions"
                  disabled={!panel || blocked || !canAct || dirtyWorkingCopy}
                />
              }
            >
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="end">
              {source && (
                <>
                  <MenuItem onClick={() => openAction("undo", source)}>
                    Undo latest operation
                  </MenuItem>
                  <MenuItem onClick={() => openAction("redo", source)}>Redo operation</MenuItem>
                  <MenuItem
                    disabled={!canRevert || !undoAvailable}
                    onClick={() => {
                      if (!panel || !receipt || !props.cwd) return;
                      setRevertReceipt(receipt);
                      setPreview({
                        environmentId: props.environmentId,
                        cwd: props.cwd,
                        panel,
                        source,
                        kind: "undo",
                        selectedCommitIds: [],
                        paths: [],
                      });
                    }}
                  >
                    Revert last panel action
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onClick={() => openAction("merge", source, { useSelection: true })}>
                    Merge selected parents
                  </MenuItem>
                  <MenuItem
                    variant="destructive"
                    onClick={() => openAction("abandon", source, { useSelection: true })}
                  >
                    Abandon selected revisions
                  </MenuItem>
                  <MenuItem onClick={() => openAction("push", source, { useSelection: true })}>
                    Push bookmarks…
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh Jujutsu"
            disabled={mutating || loading || !canRead || !supportsPanel}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!serverConfig && <p className="text-muted-foreground">Waiting for the environment…</p>}
        {serverConfig && !supportsPanel && (
          <p className="text-muted-foreground">
            This environment's T3 Code server does not support the Jujutsu panel. Update that server
            to use it.
          </p>
        )}
        {!props.cwd && <p className="text-muted-foreground">Choose a workspace to view Jujutsu.</p>}
        {!canRead && (
          <p className="text-muted-foreground">
            This connection needs orchestration read permission to view Jujutsu.
          </p>
        )}
        {error && (
          <p role="alert" className="mb-3 text-destructive">
            {error}
          </p>
        )}
        {loading && props.visible && canRead && supportsPanel && (
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            Refreshing…
          </p>
        )}
        {supportsPanel && snapshotContext === contextKey && snapshot?.status === "unavailable" && (
          <p className="text-muted-foreground">
            {snapshot.reason === "missing-executable"
              ? "Jujutsu is not installed in this environment. Install jj on that server to use this panel."
              : "This directory is not a Jujutsu workspace. Open an existing jj workspace; Git-only directories are unavailable here."}
          </p>
        )}
        {panel && source && (
          <>
            {(!canDescribe || !canAct) && (
              <p className="mb-2 text-xs text-muted-foreground">
                Source control write permission is required to edit revisions.
              </p>
            )}
            {dirtyWorkingCopy && (
              <p className="mb-2 text-xs text-warning-foreground">
                Save or cancel the working-copy description draft before running actions.
              </p>
            )}
            {rows.map(renderRevision)}
            {otherRows.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
                  Other loaded revisions · {otherRows.length}
                </summary>
                {otherRows.map(renderRevision)}
              </details>
            )}
            {panel.filesTruncated && (
              <p className="mt-2 text-xs text-muted-foreground">Changed-file list is truncated.</p>
            )}
            {props.projectId && props.onOpenPullRequest && (
              <JjForgePanel
                key={workspaceKey(panel)}
                panel={panel}
                environmentId={props.environmentId}
                projectId={props.projectId}
                disabled={blocked || dirtyWorkingCopy || Boolean(preview)}
                onOpenPullRequest={props.onOpenPullRequest}
                onPublished={() => {
                  setReceipt(null);
                  void refresh();
                }}
              />
            )}
          </>
        )}
      </div>
      {preview && (
        <JjActionDialog
          key={`${preview.panel.operationId}:${preview.source.commitId}:${preview.kind}`}
          preview={preview}
          visible={props.visible}
          busy={mutating}
          revertingPanelAction={Boolean(revertReceipt)}
          blocked={blocked || !canAct || Boolean(revertReceipt && !canRevert)}
          stale={previewStale || Boolean(revertReceipt && !undoAvailable)}
          dirtyWorkingCopy={dirtyWorkingCopy}
          error={error}
          onCancel={() => {
            setPreview(null);
            setRevertReceipt(null);
          }}
          onConfirm={(action) => {
            if (
              blocked ||
              !canAct ||
              previewStale ||
              dirtyWorkingCopy ||
              (revertReceipt && (!canRevert || !undoAvailable))
            )
              return;
            const input = {
              cwd: preview.cwd,
              workspaceIdentity: preview.panel.workspaceIdentity,
              expectedOperationId: preview.panel.operationId,
            };
            void mutate({
              title: revertReceipt ? "Panel action reverted" : jjActionLabels[preview.kind],
              run: () =>
                revertReceipt
                  ? revert({
                      environmentId: preview.environmentId,
                      input: {
                        ...input,
                        receiptId: revertReceipt.receiptId,
                        operationId: revertReceipt.operationId,
                      },
                    })
                  : runAction({
                      environmentId: preview.environmentId,
                      input: { ...input, action },
                    }),
            });
          }}
        />
      )}
    </div>
  );
};

export default JjPanel;
