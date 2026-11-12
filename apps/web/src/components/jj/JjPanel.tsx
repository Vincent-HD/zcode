import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  JjActionReceipt,
  JjLogRow,
  JjMutationResult,
  JjPanelReady,
  JjRunAction,
  ProjectId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Ellipsis, Redo2, RefreshCw, Undo2, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { observeResize } from "~/lib/observeResize";
import { readLocalApi } from "~/localApi";
import { useServerConfigs } from "~/state/entities";
import { jjEnvironment } from "~/state/jj";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import type { JjDiffContext } from "~/zcode/jj-diff-selection";
import {
  jjDropAction,
  jjMenuIntent,
  jjRevisionMenu,
  jjSquashTargets,
  type JjDialogRequest,
  type JjDragModifier,
  type JjDragSource,
  type JjMenuContext,
  type JjMenuIntent,
} from "./jj-actions";
import { JjActionDialog } from "./jj-action-dialog";
import {
  emptyJjDescriptionDrafts,
  jjDescriptionDraftScopeKey,
  useJjDescriptionDraftStore,
} from "./jj-description-draft-store";
import { beginJjDrag, consumeJjDragClick } from "./jj-drag";
import type { JjForgeSectionProps } from "./JjForgeSection";
import { JjForgePanel } from "./jj-forge-panel";
import { layoutJjGraph } from "./jj-graph-layout";
import {
  JJ_ELIDED_ROW_HEIGHT,
  JJ_ROW_HEIGHT,
  JjDragHint,
  JjElidedRow,
  JjRevisionRow,
} from "./jj-graph-rows";
import { JJ_LOG_PAGE, jjRefreshInput, mergeJjSnapshot, type JjLogView } from "./jj-log-state";
import { formatJjPanelError, historyLabel } from "./jj-panel-state";
import { JjRevisionDetailsPanel } from "./jj-revision-details";

const OVERSCAN_PX = 400;
const rowDomId = (commitId: string) => `jj-row-${commitId}`;

export interface JjOpenDiffInput {
  readonly commitId: string;
  readonly filePath?: string;
  readonly fromCommitId?: string;
  readonly context: JjDiffContext;
}

const JjPanel = (props: {
  environmentId: EnvironmentId;
  cwd: string | null;
  visible: boolean;
  projectId?: ProjectId | undefined;
  onOpenPullRequest?: JjForgeSectionProps["onOpenPullRequest"];
  onOpenDiff?: (input: JjOpenDiffInput) => void;
}) => {
  const commandOptions = { reportFailure: false, reportDefect: false };
  const getPanel = useAtomCommand(jjEnvironment.getPanel, commandOptions);
  const describe = useAtomCommand(jjEnvironment.describe, commandOptions);
  const runAction = useAtomCommand(jjEnvironment.runAction, commandOptions);
  const revert = useAtomCommand(jjEnvironment.revertOperation, commandOptions);
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const serverConfig = useServerConfigs().get(props.environmentId);
  const capabilities = serverConfig?.environment.capabilities;
  const supportsPanel = capabilities?.jjPanel === true;
  const canDescribe = useAtomValue(jjEnvironment.describe.permissionAtom(props.environmentId));
  const actionPermission = useAtomValue(
    jjEnvironment.runAction.permissionAtom(props.environmentId),
  );
  const diffPermission = useAtomValue(jjEnvironment.getDiff.permissionAtom(props.environmentId));
  const canRevert = useAtomValue(jjEnvironment.revertOperation.permissionAtom(props.environmentId));
  const publishPermission = useAtomValue(
    jjEnvironment.forgePublish.permissionAtom(props.environmentId),
  );

  const [view, setView] = useState<JjLogView>({ revset: undefined, limit: JJ_LOG_PAGE });
  const [revsetDraft, setRevsetDraft] = useState<string | null>(null);
  const [panel, setPanel] = useState<JjPanelReady | null>(null);
  const [unavailable, setUnavailable] = useState<"missing-executable" | "not-jj-workspace" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const [activeChangeId, setActiveChangeId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<JjDialogRequest<JjLogRow> | null>(null);
  const [receipt, setReceipt] = useState<JjActionReceipt | null>(null);
  const [describeRequest, setDescribeRequest] = useState<{ changeId: string; id: number } | null>(
    null,
  );
  const [forgeFocus, setForgeFocus] = useState<{ commitId: string; id: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const generation = useRef(0);
  const active = useRef(false);
  const busy = useRef(false);
  const panelRef = useRef<JjPanelReady | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const draftScopeKey =
    panel && props.cwd
      ? jjDescriptionDraftScopeKey({
          environmentId: props.environmentId,
          cwd: props.cwd,
          workspaceIdentity: panel.workspaceIdentity,
        })
      : null;
  const drafts = useJjDescriptionDraftStore((state) =>
    draftScopeKey
      ? (state.draftsByScope[draftScopeKey] ?? emptyJjDescriptionDrafts)
      : emptyJjDescriptionDrafts,
  );

  const accept = (next: JjPanelReady) => {
    const previous = panelRef.current;
    const sameWorkspace =
      previous &&
      JSON.stringify(previous.workspaceIdentity) === JSON.stringify(next.workspaceIdentity);
    panelRef.current = next;
    setPanel(next);
    setUnavailable(null);
    if (!sameWorkspace) {
      setSelection([]);
      setActiveChangeId(null);
      setReceipt(null);
      return;
    }
    const changeIds = new Set(next.rows.map((row) => row.changeId));
    setSelection((current) => current.filter((id) => changeIds.has(id)));
    setActiveChangeId((current) => (current && changeIds.has(current) ? current : null));
  };

  /** Resolves true when the server answered with a snapshot for this request. */
  const refresh = async (input?: { reload?: boolean; view?: JjLogView }): Promise<boolean> => {
    const cwd = props.cwd;
    if (
      !active.current ||
      !cwd ||
      !canRead ||
      !supportsPanel ||
      busy.current ||
      document.visibilityState === "hidden"
    )
      return false;
    const nextView = input?.view ?? view;
    const current = input?.reload ? null : panelRef.current;
    const requestGeneration = ++generation.current;
    setLoading(true);
    const result = await getPanel({
      environmentId: props.environmentId,
      input: jjRefreshInput({ cwd, view: nextView, current }),
    });
    if (!active.current || generation.current !== requestGeneration) return false;
    setLoading(false);
    if (!AsyncResult.isSuccess(result)) {
      if (result._tag === "Failure") setError(formatJjPanelError(result.cause));
      return false;
    }
    setError(null);
    const merge = mergeJjSnapshot(current, result.value);
    if (merge.type === "replace") accept(merge.panel);
    if (merge.type === "unavailable") {
      panelRef.current = null;
      setPanel(null);
      setUnavailable(merge.reason);
    }
    if (merge.type === "reload")
      return !input?.reload && (await refresh({ ...input, reload: true }));
    return true;
  };
  const refreshFromEffect = useEffectEvent(() => refresh());

  // Refreshes when the panel becomes available and when the window or document regains focus.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- manages refresh requests across access and focus changes while shown
  useEffect(() => {
    active.current = props.visible;
    if (!props.visible || !canRead || !supportsPanel) {
      generation.current++;
      return;
    }
    queueMicrotask(() => void refreshFromEffect());
    const onFocus = () => {
      if (document.visibilityState === "hidden") {
        generation.current++;
        setLoading(false);
        return;
      }
      void refreshFromEffect();
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

  // Tracks the list viewport so only the visible rows render.
  const attachList = (element: HTMLDivElement | null) => {
    listRef.current = element;
    if (!element) return;
    return observeResize(element, () => setViewportHeight(element.clientHeight));
  };

  const supportsActions = capabilities?.jjPanelActions === true;
  const canWrite = supportsActions && actionPermission && !mutating;
  const canDiff = capabilities?.jjPanelDiff === true && diffPermission && Boolean(props.onOpenDiff);
  const canPublish =
    capabilities?.jjPanelForge === true &&
    publishPermission &&
    Boolean(props.projectId && props.onOpenPullRequest);

  const viewInput = () => ({
    ...(view.revset !== undefined ? { revset: view.revset } : {}),
    limit: view.limit,
  });
  const mutate = async (input: {
    title: string;
    run: () => Promise<AsyncResult.AsyncResult<JjMutationResult, unknown>>;
    keepDialogOnError?: boolean;
    onSuccess?: () => void;
  }) => {
    if (!active.current || busy.current) return;
    busy.current = true;
    ++generation.current;
    setMutating(true);
    setLoading(false);
    const result = await input.run();
    busy.current = false;
    setMutating(false);
    if (AsyncResult.isSuccess(result)) {
      accept(result.value.panel);
      setReceipt(result.value.receipt);
      setDialog(null);
      setError(null);
      input.onSuccess?.();
      if (active.current)
        toastManager.add({
          type: "success",
          title: input.title,
          ...(result.value.receipt.undoAvailable && canRevert
            ? {
                actionProps: {
                  children: "Undo",
                  onClick: () => void revertReceipt(result.value.receipt),
                },
              }
            : {}),
        });
      return;
    }
    if (result._tag !== "Failure") return;
    const message = formatJjPanelError(result.cause);
    if (input.keepDialogOnError) setError(message);
    else if (active.current)
      toastManager.add({ type: "error", title: "Jujutsu action failed", description: message });
    void refresh();
  };
  const context = () =>
    panel && props.cwd
      ? {
          cwd: props.cwd,
          workspaceIdentity: panel.workspaceIdentity,
          expectedOperationId: panel.operationId,
          view: viewInput(),
        }
      : null;
  const run = (action: JjRunAction, title: string, options?: { keepDialogOnError?: boolean }) => {
    const base = context();
    if (!base || !canWrite) return;
    void mutate({
      title,
      ...options,
      run: () => runAction({ environmentId: props.environmentId, input: { ...base, action } }),
    });
  };
  const revertReceipt = (target: JjActionReceipt) => {
    const current = panelRef.current;
    if (!current || !props.cwd || current.operationId !== target.operationId) {
      toastManager.add({
        type: "error",
        title: "Nothing to undo",
        description: "The workspace changed after that action. Use Undo in the panel header.",
      });
      return;
    }
    const cwd = props.cwd;
    return mutate({
      title: "Action undone",
      run: () =>
        revert({
          environmentId: props.environmentId,
          input: {
            cwd,
            workspaceIdentity: current.workspaceIdentity,
            expectedOperationId: current.operationId,
            view: viewInput(),
            receiptId: target.receiptId,
            operationId: target.operationId,
          },
        }),
    });
  };
  const saveDescription = (row: JjLogRow, description: string) => {
    const base = context();
    if (!base || !canDescribe || !draftScopeKey) return;
    const savedDraft = drafts[row.changeId];
    const scopeKey = draftScopeKey;
    void mutate({
      title: "Description saved",
      run: () =>
        describe({
          environmentId: props.environmentId,
          input: { ...base, revisionCommitId: row.commitId, description },
        }),
      onSuccess: () => {
        setDescribeRequest(null);
        useJjDescriptionDraftStore
          .getState()
          .clearSavedDraft({ scopeKey, changeId: row.changeId, savedDraft });
      },
    });
  };

  const rows = panel?.rows ?? [];
  // The React Compiler memoizes these on `rows`, which only changes with a new snapshot.
  const layout = layoutJjGraph(rows);
  const offsets = [0];
  for (const item of layout.items)
    offsets.push(
      offsets.at(-1)! + (item.kind === "revision" ? JJ_ROW_HEIGHT : JJ_ELIDED_ROW_HEIGHT),
    );
  const totalHeight = offsets.at(-1) ?? 0;
  const firstVisible = (() => {
    let low = 0;
    let high = layout.items.length;
    const top = scrollTop - OVERSCAN_PX;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (offsets[mid + 1]! <= top) low = mid + 1;
      else high = mid;
    }
    return low;
  })();
  const visibleItems: number[] = [];
  for (
    let index = firstVisible;
    index < layout.items.length && offsets[index]! < scrollTop + viewportHeight + OVERSCAN_PX;
    index++
  )
    visibleItems.push(index);

  const byChange = new Map<string, JjLogRow>();
  for (const row of rows) if (!byChange.has(row.changeId)) byChange.set(row.changeId, row);
  const selectedRows = selection.flatMap((id) => byChange.get(id) ?? []);
  const activeRow = activeChangeId ? byChange.get(activeChangeId) : undefined;
  const revisionIndexes = layout.items.flatMap((item, index) =>
    item.kind === "revision" ? [index] : [],
  );

  const scrollToItem = (index: number) => {
    const element = listRef.current;
    const top = offsets[index];
    if (!element || top === undefined) return;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + JJ_ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + JJ_ROW_HEIGHT - element.clientHeight;
  };
  const activate = (row: JjLogRow, mode: "single" | "toggle") => {
    setActiveChangeId(row.changeId);
    setSelection((current) =>
      mode === "single"
        ? [row.changeId]
        : current.includes(row.changeId)
          ? current.filter((id) => id !== row.changeId)
          : [...current, row.changeId],
    );
  };

  const menuContext = (
    row: JjLogRow,
  ): JjMenuContext<JjLogRow> & { workingCopyCommitId: string } => ({
    row,
    rows,
    selection: selectedRows,
    canWrite,
    canDiff,
    canPublish,
    workingCopyCommitId: panel?.workingCopyCommitId ?? "",
  });
  const openDiff = (input: { commitId: string; filePath?: string; fromCommitId?: string }) => {
    if (!panel || !canDiff) return;
    props.onOpenDiff?.({
      ...input,
      context: {
        workspaceIdentity: panel.workspaceIdentity,
        expectedOperationId: panel.operationId,
      },
    });
  };
  const copy = (value: string, label: string) => {
    void writeTextToClipboard(value, label).then(
      () => toastManager.add({ type: "success", title: `${label} copied` }),
      () => toastManager.add({ type: "error", title: `Could not copy ${label.toLowerCase()}` }),
    );
  };
  const perform = (intent: JjMenuIntent<JjLogRow>) => {
    switch (intent.type) {
      case "run":
        return run(intent.action, intent.title);
      case "dialog":
        setError(null);
        return setDialog(intent.request);
      case "diff":
        return openDiff(intent);
      case "copy":
        return copy(intent.value, intent.label);
      case "describe":
        setActiveChangeId(intent.row.changeId);
        return setDescribeRequest((current) => ({
          changeId: intent.row.changeId,
          id: (current?.id ?? 0) + 1,
        }));
      case "publish":
        return setForgeFocus((current) => ({
          commitId: intent.row.commitId,
          id: (current?.id ?? 0) + 1,
        }));
    }
  };
  const openContextMenu = async (row: JjLogRow, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || !panel) return;
    const contextValue = menuContext(row);
    const chosen = await api.contextMenu.show(jjRevisionMenu(contextValue), position);
    if (!chosen) return;
    const intent = jjMenuIntent(chosen, contextValue);
    if (intent) perform(intent);
  };
  const onDrop = (drop: {
    source: JjDragSource;
    targetCommitId: string;
    modifier: JjDragModifier;
  }) => {
    const result = jjDropAction({ ...drop, rows });
    if (!result.ok) {
      toastManager.add({ type: "error", title: result.reason });
      return;
    }
    run(result.action, result.label);
  };
  const onRowPointerDown = (event: React.PointerEvent, source: JjDragSource) => {
    if (!canWrite) return;
    beginJjDrag({ event, source, onDrop });
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (!panel || revisionIndexes.length === 0) return;
    const currentIndex = layout.items.findIndex(
      (item) => item.kind === "revision" && item.row.changeId === activeChangeId,
    );
    const position = revisionIndexes.indexOf(currentIndex);
    const move = (next: number) => {
      const index = revisionIndexes[Math.max(0, Math.min(revisionIndexes.length - 1, next))];
      const item = index === undefined ? undefined : layout.items[index];
      if (!item || item.kind !== "revision" || index === undefined) return;
      event.preventDefault();
      setActiveChangeId(item.row.changeId);
      if (!event.shiftKey) setSelection([item.row.changeId]);
      scrollToItem(index);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(position === -1 ? 0 : position + 1);
      case "ArrowUp":
        return move(position === -1 ? 0 : position - 1);
      case "Home":
        return move(0);
      case "End":
        return move(revisionIndexes.length - 1);
      case " ":
        if (activeRow) {
          event.preventDefault();
          activate(activeRow, "toggle");
        }
        return;
      case "Escape":
        if (selection.length || activeChangeId) {
          event.preventDefault();
          setSelection([]);
          setActiveChangeId(null);
        }
        return;
      case "ContextMenu":
      case "F10":
        if (activeRow && (event.key === "ContextMenu" || event.shiftKey)) {
          event.preventDefault();
          const rect = document
            .getElementById(rowDomId(activeRow.commitId))
            ?.getBoundingClientRect();
          void openContextMenu(activeRow, {
            x: (rect?.left ?? 0) + 24,
            y: (rect?.top ?? 0) + JJ_ROW_HEIGHT / 2,
          });
        }
        return;
    }
  };

  const applyRevset = () => {
    if (revsetDraft === null) return;
    const value = revsetDraft.trim();
    // Typing the configured default back keeps following `revsets.log` instead of pinning it.
    const revset =
      !value || (value === panel?.revset && view.revset === undefined) ? undefined : value;
    const nextView = { revset, limit: JJ_LOG_PAGE };
    // An invalid revset keeps the current graph and the typed text so it can be fixed.
    void refresh({ reload: true, view: nextView }).then((accepted) => {
      if (!accepted) return;
      setView(nextView);
      setRevsetDraft(null);
      if (listRef.current) listRef.current.scrollTop = 0;
    });
  };
  const loadMore = () => {
    const nextView = { ...view, limit: Math.min(2000, view.limit + JJ_LOG_PAGE) };
    setView(nextView);
    void refresh({ view: nextView });
  };

  const blocked = mutating || !canWrite;
  const status = (() => {
    if (!serverConfig) return "Waiting for the environment…";
    if (!supportsPanel)
      return "This environment's T3 Code server does not support the Jujutsu panel. Update that server to use it.";
    if (!props.cwd) return "Choose a workspace to view Jujutsu.";
    if (!canRead) return "This connection needs orchestration read permission to view Jujutsu.";
    if (unavailable === "missing-executable")
      return "Jujutsu is not installed in this environment. Install jj on that server to use this panel.";
    if (unavailable === "not-jj-workspace")
      return "This directory is not a Jujutsu workspace. Run `jj git init --colocate` in it, or open an existing jj workspace.";
    return null;
  })();
  const editRequested = Boolean(activeRow && describeRequest?.changeId === activeRow.changeId);
  const squashAncestor = activeRow
    ? jjSquashTargets({ source: activeRow, rows, scope: "ancestors" }).length > 0
    : false;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="space-y-1 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Undo last operation"
                  disabled={!panel?.undo || blocked}
                  onClick={() => run({ type: "undo" }, "Operation undone")}
                />
              }
            >
              <Undo2 />
            </TooltipTrigger>
            <TooltipPopup>{historyLabel("Undo", panel?.undo)}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Redo operation"
                  disabled={!panel?.redo || blocked}
                  onClick={() => run({ type: "redo" }, "Operation redone")}
                />
              }
            >
              <Redo2 />
            </TooltipTrigger>
            <TooltipPopup>{historyLabel("Redo", panel?.redo)}</TooltipPopup>
          </Tooltip>
          <span
            className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {selection.length > 1
              ? `${selection.length} selected`
              : mutating
                ? "Applying…"
                : loading && props.visible && canRead && supportsPanel
                  ? "Refreshing…"
                  : panel
                    ? `${panel.rows.length}${panel.hasMore ? "+" : ""} revisions`
                    : ""}
          </span>
          {selection.length > 1 && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear selection"
              onClick={() => setSelection(activeChangeId ? [activeChangeId] : [])}
            >
              <X />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh Jujutsu"
            disabled={mutating || loading || !canRead || !supportsPanel}
            onClick={() => void refresh({ reload: true })}
          >
            <RefreshCw />
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Jujutsu actions"
                  disabled={!panel}
                />
              }
            >
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                disabled={
                  !canRevert ||
                  !receipt?.undoAvailable ||
                  receipt.operationId !== panel?.operationId
                }
                onClick={() => receipt && void revertReceipt(receipt)}
              >
                Revert last panel action
              </MenuItem>
              <MenuItem
                disabled={blocked || !activeRow}
                onClick={() => activeRow && setDialog({ kind: "push", revision: activeRow })}
              >
                Push bookmarks…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={view.revset === undefined}
                onClick={() => {
                  const nextView = { revset: undefined, limit: JJ_LOG_PAGE };
                  setView(nextView);
                  setRevsetDraft(null);
                  void refresh({ reload: true, view: nextView });
                }}
              >
                Reset revset to default
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        <Input
          size="sm"
          aria-label="Revset"
          spellCheck={false}
          placeholder={panel?.revset ?? "revset"}
          value={revsetDraft ?? view.revset ?? panel?.revset ?? ""}
          onChange={(event) => setRevsetDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyRevset();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setRevsetDraft(null);
            }
          }}
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {status && <p className="px-3 py-2 text-muted-foreground">{status}</p>}
      {!status && panel && (
        <>
          {!canWrite && !mutating && (
            <p className="border-b px-3 py-1 text-xs text-muted-foreground">
              Source control write permission is required to change revisions.
            </p>
          )}
          <div
            ref={attachList}
            role="listbox"
            tabIndex={0}
            aria-label="Revision graph"
            aria-multiselectable="true"
            aria-activedescendant={activeRow ? rowDomId(activeRow.commitId) : undefined}
            className="relative min-h-0 flex-1 overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onKeyDown={onListKeyDown}
          >
            <div className="relative" style={{ height: totalHeight }}>
              {visibleItems.map((index) => {
                const item = layout.items[index]!;
                const cell = layout.cells[index]!;
                const top = offsets[index]!;
                if (item.kind === "elided")
                  return <JjElidedRow key={item.key} cell={cell} width={layout.width} top={top} />;
                return (
                  <JjRevisionRow
                    key={item.key}
                    id={rowDomId(item.row.commitId)}
                    row={item.row}
                    cell={cell}
                    width={layout.width}
                    top={top}
                    selected={selection.includes(item.row.changeId)}
                    active={activeChangeId === item.row.changeId}
                    {...(canWrite ? { onPointerDown: onRowPointerDown } : {})}
                    onClick={(event, row) => {
                      if (consumeJjDragClick()) return;
                      activate(row, event.metaKey || event.ctrlKey ? "toggle" : "single");
                    }}
                    onContextMenu={(event, row) => {
                      event.preventDefault();
                      void openContextMenu(row, { x: event.clientX, y: event.clientY });
                    }}
                  />
                );
              })}
            </div>
            {panel.hasMore && (
              <div className="p-2">
                <Button size="xs" variant="outline" disabled={loading} onClick={loadMore}>
                  Load {JJ_LOG_PAGE} more
                </Button>
              </div>
            )}
          </div>
          {activeRow && props.cwd && (
            <div className="max-h-[45%] shrink-0 overflow-y-auto border-t">
              <JjRevisionDetailsPanel
                key={`${activeRow.commitId}:${editRequested ? (describeRequest?.id ?? 0) : 0}`}
                environmentId={props.environmentId}
                cwd={props.cwd}
                row={activeRow}
                parent={rows.find((row) => row.commitId === activeRow.parentIds[0])}
                canWrite={canWrite}
                canDescribe={canDescribe && canWrite}
                canDiff={canDiff}
                busy={mutating}
                hasSquashAncestor={squashAncestor}
                autoEdit={editRequested}
                draft={drafts[activeRow.changeId]}
                onDraftChange={(draft) => {
                  if (!draftScopeKey) return;
                  const changeId = activeRow.changeId;
                  useJjDescriptionDraftStore.getState().setDrafts({
                    scopeKey: draftScopeKey,
                    update: (current) => {
                      const next = { ...current };
                      if (draft) next[changeId] = draft;
                      else delete next[changeId];
                      return next;
                    },
                  });
                }}
                onDescribe={(description) => saveDescription(activeRow, description)}
                onCopy={copy}
                onOpenDiff={openDiff}
                onRun={run}
                onDialog={(request) => {
                  setError(null);
                  setDialog(request);
                }}
              />
            </div>
          )}
          {props.projectId && props.onOpenPullRequest && props.cwd && (
            <div className="shrink-0">
              <JjForgePanel
                key={JSON.stringify(panel.workspaceIdentity)}
                panel={{ ...panel, cwd: props.cwd }}
                focusRequest={forgeFocus}
                environmentId={props.environmentId}
                projectId={props.projectId}
                disabled={mutating || loading || Boolean(dialog)}
                onOpenPullRequest={props.onOpenPullRequest}
                onPublished={() => {
                  setReceipt(null);
                  void refresh();
                }}
              />
            </div>
          )}
        </>
      )}
      <JjDragHint rows={rows} />
      {dialog && panel && props.cwd && (
        <JjActionDialog
          request={dialog}
          environmentId={props.environmentId}
          cwd={props.cwd}
          rows={rows}
          remotes={panel.remotes}
          busy={mutating}
          error={error}
          onCancel={() => {
            setDialog(null);
            setError(null);
          }}
          onConfirm={(action, title) => run(action, title, { keepDialogOnError: true })}
        />
      )}
    </div>
  );
};

export default JjPanel;
