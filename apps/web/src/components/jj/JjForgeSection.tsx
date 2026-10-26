import type { EnvironmentId, ProjectId, JjPanelReady, PullRequestRef } from "@t3tools/contracts";
import {
  JjForgePreviewInput,
  type JjForgePlan,
  type JjForgePublishInput,
  type JjForgePublishResult,
  type JjForgeStatusInput,
  type JjForgeStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { PULL_REQUEST_STATE_PRESENTATION } from "~/components/pullRequest/pullRequestIcons";
import { jjForgeFailureMessage, selectJjForgeChain } from "./jj-forge-state";

type ScopedInput<T> = { environmentId: EnvironmentId; input: T };
const decodePreviewInput = Schema.decodeSync(JjForgePreviewInput);

export interface JjForgeSectionProps {
  panel: JjPanelReady;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  canRead: boolean;
  canPublish: boolean;
  disabled?: boolean;
  initialRemote?: string;
  initialBaseBookmark?: string;
  onPreview: (input: ScopedInput<JjForgePreviewInput>) => Promise<JjForgePlan>;
  onPublish: (input: ScopedInput<JjForgePublishInput>) => Promise<JjForgePublishResult>;
  onRefreshStatus: (input: ScopedInput<JjForgeStatusInput>) => Promise<JjForgeStatusResult>;
  onOpenPullRequest: (input: {
    environmentId: EnvironmentId;
    reference: PullRequestRef;
    url: string;
  }) => void;
  onPublished?: (input: ScopedInput<JjForgePublishResult>) => void;
}

export const JjForgeSection = (props: JjForgeSectionProps) => {
  const [expanded, setExpanded] = useState(false);
  const [remote, setRemote] = useState(props.initialRemote ?? "origin");
  const [baseBookmark, setBaseBookmark] = useState(props.initialBaseBookmark ?? "");
  const [mode, setMode] = useState<JjForgePreviewInput["mode"]>("single");
  const [targetCommitId, setTargetCommitId] = useState(props.panel.workingCopyCommitId);
  const [bookmarks, setBookmarks] = useState<Readonly<Record<string, string>>>({});
  const [preview, setPreview] = useState<{
    environmentId: EnvironmentId;
    plan: JjForgePlan;
  } | null>(null);
  const [status, setStatus] = useState<{
    operationId: string;
    workspaceId: string;
    environmentId: EnvironmentId;
    projectId: ProjectId;
    remote: string;
    value: JjForgeStatusResult;
  } | null>(null);
  const [publication, setPublication] = useState<{
    environmentId: EnvironmentId;
    projectId: ProjectId;
    workspaceId: string;
    value: JjForgePublishResult;
  } | null>(null);
  const result =
    publication?.environmentId === props.environmentId &&
    publication.projectId === props.projectId &&
    publication.workspaceId === props.panel.workspaceIdentity.workspaceId
      ? publication.value
      : null;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const revisions = [...props.panel.revisions, ...(props.panel.visibleRevisions ?? [])].filter(
    (revision, index, all) =>
      all.findIndex((candidate) => candidate.commitId === revision.commitId) === index,
  );
  const effectiveTargetCommitId = revisions.some(
    (revision) => revision.commitId === targetCommitId && !revision.immutable,
  )
    ? targetCommitId
    : (revisions.find((revision) => !revision.immutable && Boolean(revision.bookmarks?.length))
        ?.commitId ?? props.panel.workingCopyCommitId);
  const chain = selectJjForgeChain({
    panel: props.panel,
    targetCommitId: effectiveTargetCommitId,
    mode,
    bookmarks,
  });
  const blocked = pending || Boolean(props.disabled);
  const previewStale = Boolean(
    preview &&
    (preview.environmentId !== props.environmentId ||
      preview.plan.input.projectId !== props.projectId ||
      preview.plan.input.expectedOperationId !== props.panel.operationId ||
      preview.plan.input.workspaceIdentity.workspaceId !==
        props.panel.workspaceIdentity.workspaceId ||
      preview.plan.input.workspaceIdentity.repositoryPath !==
        props.panel.workspaceIdentity.repositoryPath ||
      preview.plan.input.workspaceIdentity.workspaceRoot !==
        props.panel.workspaceIdentity.workspaceRoot),
  );
  const statusCurrent =
    status?.environmentId === props.environmentId &&
    status.projectId === props.projectId &&
    status.remote === remote &&
    status.operationId === props.panel.operationId &&
    status.workspaceId === props.panel.workspaceIdentity.workspaceId;
  const run = async (action: () => Promise<void>) => {
    if (blocked) return;
    setPending(true);
    setFailure(null);
    try {
      await action();
    } catch (cause) {
      setFailure(jjForgeFailureMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="border-t border-border/50 px-2 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          className="min-w-0 py-1 text-left font-medium focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "▾" : "▸"} PR / review
          {statusCurrent &&
            status &&
            status.value.revisions.length > 0 &&
            ` · ${status.value.revisions.length}`}
        </button>
        {expanded && (
          <Button
            size="xs"
            variant="ghost"
            disabled={blocked || !props.canRead || !remote}
            onClick={() => {
              const panel = props.panel;
              const environmentId = props.environmentId;
              const projectId = props.projectId;
              void run(async () => {
                const value = await props.onRefreshStatus({
                  environmentId,
                  input: {
                    cwd: panel.cwd,
                    workspaceIdentity: panel.workspaceIdentity,
                    expectedOperationId: panel.operationId,
                    projectId,
                    remote,
                    revisionCommitIds: revisions.slice(0, 32).map((revision) => revision.commitId),
                  },
                });
                setStatus({
                  environmentId,
                  projectId,
                  remote,
                  operationId: panel.operationId,
                  workspaceId: panel.workspaceIdentity.workspaceId,
                  value,
                });
              });
            }}
          >
            {pending ? "Loading…" : "Refresh reviews"}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="space-y-2 pb-2">
          {statusCurrent && status ? (
            <>
              {status.value.revisions.map((revision) => {
                const presentation =
                  PULL_REQUEST_STATE_PRESENTATION[
                    revision.summary.isDraft && revision.summary.state === "open"
                      ? "draft"
                      : revision.summary.state
                  ];
                const Icon = presentation.Icon;
                return (
                  <div
                    key={`${revision.commitId}:${revision.bookmark}:${revision.reference.number}`}
                    className="flex items-start gap-1.5"
                  >
                    <Icon className={`mt-0.5 size-3.5 shrink-0 ${presentation.toneClassName}`} />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() =>
                        props.onOpenPullRequest({
                          environmentId: props.environmentId,
                          reference: revision.reference,
                          url: revision.summary.url,
                        })
                      }
                    >
                      <span className="block truncate">
                        {revision.bookmark} · #{revision.reference.number} · {presentation.label}
                      </span>
                      <span className="block text-muted-foreground">
                        {revision.commitId.slice(0, 8)}
                        {revision.summary.reviewDecision &&
                          ` · ${revision.summary.reviewDecision.replaceAll("-", " ")}`}
                        {revision.unresolvedThreadCount !== null &&
                          ` · ${revision.unresolvedThreadCount}${revision.reviewThreadsTruncated ? "+" : ""} unresolved`}
                        {revision.headMatches === false && " · remote head differs"}
                        {revision.headMatches === null && " · head not reported"}
                      </span>
                    </button>
                  </div>
                );
              })}
              {status.value.revisions.length === 0 && (
                <p className="text-muted-foreground">No PR/MR loaded for these local bookmarks.</p>
              )}
              {status.value.unavailableBookmarks.length > 0 && (
                <p role="status" className="text-warning-foreground">
                  Some review reads failed: {status.value.unavailableBookmarks.join(", ")}. Open the
                  existing PR panel to retry.
                </p>
              )}
              {status.value.truncated && (
                <p className="text-muted-foreground">Review results are truncated.</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              Refresh to load PR/MR status for these revisions.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label>
              Remote
              <Input
                size="sm"
                value={remote}
                disabled={blocked}
                onChange={(event) => setRemote(event.target.value)}
              />
            </label>
            <label>
              Base bookmark
              <Input
                size="sm"
                value={baseBookmark}
                placeholder="Choose base"
                disabled={blocked}
                onChange={(event) => setBaseBookmark(event.target.value)}
              />
            </label>
          </div>
          <label className="block">
            Publish
            <select
              className="mt-1 block w-full rounded border border-input bg-background p-1"
              value={mode}
              disabled={blocked}
              onChange={(event) =>
                setMode(event.target.value === "linear-stack" ? "linear-stack" : "single")
              }
            >
              <option value="single">One revision + PR/MR</option>
              <option value="linear-stack">Linear stack + PR/MR chain</option>
            </select>
          </label>
          <label className="block">
            {mode === "single" ? "Revision" : "Top revision"}
            <select
              className="mt-1 block w-full rounded border border-input bg-background p-1"
              value={effectiveTargetCommitId}
              disabled={blocked}
              onChange={(event) => setTargetCommitId(event.target.value)}
            >
              {revisions
                .filter((revision) => !revision.immutable)
                .map((revision) => (
                  <option key={revision.commitId} value={revision.commitId}>
                    {revision.changeId.slice(0, 8)} ·{" "}
                    {revision.description.split("\n")[0] || "(no description)"}
                  </option>
                ))}
            </select>
          </label>
          {chain.selections.map((selection) => (
            <label className="block" key={selection.commitId}>
              Bookmark for {selection.commitId.slice(0, 8)}
              <select
                className="mt-1 block w-full rounded border border-input bg-background p-1"
                value={selection.bookmark}
                disabled={blocked}
                onChange={(event) =>
                  setBookmarks((previous) => ({
                    ...previous,
                    [selection.commitId]: event.target.value,
                  }))
                }
              >
                {revisions
                  .find((revision) => revision.commitId === selection.commitId)
                  ?.bookmarks?.map((bookmark) => (
                    <option key={bookmark} value={bookmark}>
                      {bookmark}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          {chain.issue && <p className="text-muted-foreground">{chain.issue}</p>}
          {!props.canPublish && (
            <p className="text-muted-foreground">
              Source control write permission is required to publish.
            </p>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={
              blocked ||
              !props.canRead ||
              !props.canPublish ||
              Boolean(chain.issue) ||
              !baseBookmark ||
              !remote
            }
            onClick={() => {
              void run(async () => {
                const input = decodePreviewInput({
                  cwd: props.panel.cwd,
                  workspaceIdentity: props.panel.workspaceIdentity,
                  expectedOperationId: props.panel.operationId,
                  projectId: props.projectId,
                  remote,
                  baseBookmark,
                  mode,
                  selections: chain.selections,
                });
                const plan = await props.onPreview({ environmentId: props.environmentId, input });
                setPublication(null);
                setPreview({ environmentId: props.environmentId, plan });
              });
            }}
          >
            Preview publication…
          </Button>
          {result && (
            <p
              role="status"
              className={
                result.failedBookmark ? "text-warning-foreground" : "text-muted-foreground"
              }
            >
              Bookmarks pushed. {result.layers.length} PR/MR{result.layers.length === 1 ? "" : "s"}{" "}
              connected.
              {result.failedBookmark &&
                ` Synchronization stopped at ${result.failedBookmark}. Check the forge before retrying; remote writes cannot be undone locally.`}
            </p>
          )}
          {result?.layers.map((layer) => (
            <Button
              key={layer.bookmark}
              size="xs"
              variant="link"
              onClick={() =>
                props.onOpenPullRequest({
                  environmentId: props.environmentId,
                  reference: layer.reference,
                  url: layer.url,
                })
              }
            >
              Open {layer.bookmark} · #{layer.reference.number}
            </Button>
          ))}
          {failure && (
            <p role="alert" className="text-destructive">
              {failure}
            </p>
          )}
        </div>
      )}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open && !pending) setPreview(null);
        }}
      >
        <DialogPopup showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>
              Publish {preview?.plan.layers.length === 1 ? "revision" : "linear stack"}
            </DialogTitle>
            <DialogDescription>
              Push the listed bookmarks and create or reuse their connected PR/MR chain. Remote
              writes cannot be undone by JJ undo.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 px-6 pb-6 text-sm">
              <p className="break-all">
                {preview.plan.destination.provider} · {preview.plan.destination.host}/
                {preview.plan.destination.repository}
                <br />
                Remote: <strong>{preview.plan.destination.remote}</strong>
              </p>
              <ol className="space-y-2">
                {preview.plan.layers.map((layer) => (
                  <li key={layer.bookmark}>
                    <p className="break-all font-mono text-xs">
                      {layer.bookmark} → {layer.baseBookmark}
                    </p>
                    <p className="break-words">{layer.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {layer.commitId.slice(0, 8)} ·{" "}
                      {layer.existing ? `Reuse #${layer.existing.number}` : "Create PR/MR"}
                    </p>
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted-foreground">
                Each selected revision's saved description supplies its new PR/MR title and body.
                Existing titles, descriptions, and review conversations are preserved.
              </p>
              {previewStale && (
                <p role="alert" className="text-destructive">
                  The workspace or environment changed. Cancel and preview again.
                </p>
              )}
              {failure && (
                <p role="alert" className="text-destructive">
                  {failure}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              disabled={blocked || !props.canPublish || previewStale || !preview}
              onClick={() => {
                if (!preview || previewStale || !props.canPublish) return;
                const confirmed = preview;
                void run(async () => {
                  const value = await props.onPublish({
                    environmentId: confirmed.environmentId,
                    input: {
                      ...confirmed.plan.input,
                      expectedDestination: confirmed.plan.destination,
                    },
                  });
                  setPublication({
                    environmentId: confirmed.environmentId,
                    projectId: confirmed.plan.input.projectId,
                    workspaceId: confirmed.plan.input.workspaceIdentity.workspaceId,
                    value,
                  });
                  setPreview(null);
                  setStatus(null);
                  props.onPublished?.({ environmentId: confirmed.environmentId, input: value });
                });
              }}
            >
              Push bookmarks & connect PR/MRs
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
};
