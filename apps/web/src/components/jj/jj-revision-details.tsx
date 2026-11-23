import type {
  EnvironmentId,
  JjLogRow,
  JjRevisionDetails,
  JjRunAction,
  JjSignature,
} from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { FileDiff } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { m } from "~/i18n/messages";
import { jjEnvironment } from "~/state/jj";
import { useAtomCommand } from "~/state/use-atom-command";
import type { JjDialogRequest } from "./jj-actions";
import { JjFileActions, JjFileRow } from "./jj-file-row";
import { JjChangeId, JjHint, JjRefPills, JjRelativeTime } from "./jj-graph-rows";
import {
  descriptionDraftIsStale,
  formatJjPanelError,
  type DescriptionDraft,
} from "./jj-panel-state";

const Signature = (props: { label: string; signature: JjSignature }) => (
  <JjHint
    label={`${props.signature.email} · ${props.signature.timestamp}`}
    render={<p className="truncate" />}
  >
    <span className="text-muted-foreground">{props.label} </span>
    {props.signature.name || props.signature.email}
    <span className="text-muted-foreground">
      {" "}
      · <JjRelativeTime timestamp={props.signature.timestamp} />
    </span>
  </JjHint>
);

export interface JjRevisionDetailsProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly row: JjLogRow;
  readonly parent: JjLogRow | undefined;
  readonly canWrite: boolean;
  readonly canDescribe: boolean;
  readonly canDiff: boolean;
  readonly busy: boolean;
  readonly hasSquashAncestor: boolean;
  /** Opens the description editor on mount; the parent remounts the panel to request it again. */
  readonly autoEdit: boolean;
  readonly draft: DescriptionDraft | undefined;
  readonly onDraftChange: (draft: DescriptionDraft | undefined) => void;
  readonly onDescribe: (description: string) => void;
  readonly onCopy: (value: string, label: string) => void;
  readonly onOpenDiff: (input: { commitId: string; filePath?: string }) => void;
  readonly onRun: (action: JjRunAction, title: string) => void;
  readonly onDialog: (request: JjDialogRequest<JjLogRow>) => void;
}

/** Details for one revision. Content is read lazily per commit id, which never changes. */
export const JjRevisionDetailsPanel = (props: JjRevisionDetailsProps) => {
  const gt = useGT();
  const { row } = props;
  const getRevision = useAtomCommand(jjEnvironment.getRevision, {
    reportFailure: false,
    reportDefect: false,
  });
  const [loaded, setLoaded] = useState<{
    commitId: string;
    details: JjRevisionDetails | null;
    error: string | null;
  } | null>(null);
  const [editing, setEditing] = useState(props.autoEdit);
  const current = loaded?.commitId === row.commitId ? loaded : null;
  const details = current?.details ?? null;
  const commitId = row.commitId;
  const { environmentId, cwd } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads remote revision details for the selected commit and drops replies for a previous one
  useEffect(() => {
    let cancelled = false;
    void getRevision({ environmentId, input: { cwd, commitId } }).then((result) => {
      if (cancelled) return;
      setLoaded(
        result._tag === "Success"
          ? { commitId, details: result.value, error: null }
          : { commitId, details: null, error: formatJjPanelError(result.cause) },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [getRevision, environmentId, cwd, commitId]);

  const locked = Boolean(row.immutable || row.root);
  const fileActionsDisabled = !props.canWrite || props.busy || locked;
  const draft = props.draft;
  const stale = Boolean(draft && details && descriptionDraftIsStale({ draft, revision: details }));
  const text = draft?.text ?? details?.description ?? "";
  const dirty = Boolean(draft && draft.text !== draft.baseDescription);
  const save = () => {
    props.onDescribe(text);
    setEditing(false);
  };

  return (
    <section aria-label={gt("Revision details")} className="space-y-2 px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <JjHint
          label={gt("Copy change ID")}
          render={
            <button
              type="button"
              aria-label={gt("Copy change ID")}
              className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => props.onCopy(row.changeId, m(msg("Change ID")))}
            />
          }
        >
          <JjChangeId row={row} length={12} />
        </JjHint>
        <JjHint
          label={gt("Copy commit ID")}
          render={
            <button
              type="button"
              aria-label={gt("Copy commit ID")}
              className="rounded-sm font-mono text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => props.onCopy(row.commitId, m(msg("Commit ID")))}
            />
          }
        >
          {row.commitId.slice(0, Math.max(8, row.commitPrefixLength))}
        </JjHint>
        {row.current && (
          <Badge size="sm" variant="info">
            <T context="revision state">working copy</T>
          </Badge>
        )}
        {locked && (
          <Badge size="sm" variant="secondary">
            <T context="revision state">immutable</T>
          </Badge>
        )}
        {row.empty && !row.root && (
          <Badge size="sm" variant="outline">
            <T context="revision state, no changes">empty</T>
          </Badge>
        )}
        {row.conflict && (
          <Badge size="sm" variant="error">
            <T context="revision state">conflicted</T>
          </Badge>
        )}
        {row.divergent && (
          <Badge size="sm" variant="warning">
            <T context="revision state">divergent</T>
          </Badge>
        )}
        {row.hidden && (
          <Badge size="sm" variant="outline">
            <T context="revision state">hidden</T>
          </Badge>
        )}
        <JjRefPills row={row} />
      </div>
      {current?.error && (
        <p role="alert" className="text-destructive">
          {current.error}
        </p>
      )}
      {!current && (
        <p className="text-muted-foreground">
          <T>Loading revision…</T>
        </p>
      )}
      {details && (
        <>
          <div className="space-y-0.5">
            <Signature label={gt("Author")} signature={details.author} />
            {(details.committer.email !== details.author.email ||
              details.committer.timestamp !== details.author.timestamp) && (
              <Signature label={gt("Committer")} signature={details.committer} />
            )}
          </div>
          {editing && !locked ? (
            <div className="space-y-1.5">
              <Textarea
                size="sm"
                autoFocus
                aria-label={gt("Description for {revision}", {
                  revision: row.changeId.slice(0, 8),
                })}
                value={text}
                disabled={props.busy}
                onChange={(event) =>
                  props.onDraftChange({
                    text: event.target.value,
                    baseDescription: draft?.baseDescription ?? details.description,
                    baseCommitId: draft?.baseCommitId ?? details.commitId,
                  })
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setEditing(false);
                  }
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    dirty &&
                    !stale
                  ) {
                    event.preventDefault();
                    save();
                  }
                }}
              />
              {stale && (
                <p className="text-warning-foreground">
                  <T>
                    This revision changed after you started editing. Discard to load its current
                    description.
                  </T>
                </p>
              )}
              <div className="flex gap-1">
                <Button
                  size="xs"
                  disabled={props.busy || !props.canDescribe || stale || !dirty}
                  onClick={save}
                >
                  <T>Save description</T>
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => {
                    props.onDraftChange(undefined);
                    setEditing(false);
                  }}
                >
                  <T context="verb, drops a draft">Discard</T>
                </Button>
              </div>
            </div>
          ) : (
            <div className="group/description flex items-start gap-1">
              <p
                className={
                  details.description
                    ? "min-w-0 flex-1 whitespace-pre-wrap break-words"
                    : "min-w-0 flex-1 text-muted-foreground italic"
                }
              >
                {details.description.trimEnd() || gt("(no description)")}
              </p>
              {!locked && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.busy || !props.canDescribe}
                  onClick={() => setEditing(true)}
                >
                  {dirty
                    ? gt("Resume draft")
                    : gt("Describe", { $context: "verb, edits a description" })}
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground">
              {gt(
                "{count, plural, one {{count}{more} changed file} other {{count}{more} changed files}}",
                { count: details.files.length, more: details.filesTruncated ? "+" : "" },
              )}
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={!props.canDiff || details.files.length === 0}
              onClick={() => props.onOpenDiff({ commitId: row.commitId })}
            >
              <FileDiff />
              <T>Show diff</T>
            </Button>
          </div>
          <ul className="space-y-0.5">
            {details.files.map((file) => (
              <JjFileRow
                key={file.path}
                file={file}
                conflict={details.conflictPaths.includes(file.path)}
                canDiff={props.canDiff}
                onOpenDiff={() => props.onOpenDiff({ commitId: row.commitId, filePath: file.path })}
                actions={
                  !locked && (
                    <JjFileActions
                      commitId={row.commitId}
                      path={file.path}
                      disabled={fileActionsDisabled}
                      squashParentId={
                        row.conflict ||
                        row.parentIds.length !== 1 ||
                        (props.parent && (props.parent.immutable || props.parent.conflict))
                          ? undefined
                          : row.parentIds[0]
                      }
                      squashAncestor={{
                        enabled: !row.conflict && props.hasSquashAncestor,
                        onClick: () =>
                          props.onDialog({
                            kind: "squash-ancestor",
                            source: row,
                            paths: [file.path],
                          }),
                      }}
                      onRun={props.onRun}
                      onDialog={props.onDialog}
                    />
                  )
                }
              />
            ))}
          </ul>
          {details.conflictPaths
            .filter((path) => !details.files.some((file) => file.path === path))
            .map((path) => (
              <p key={path} className="break-all text-destructive">
                <T>
                  Conflict · <Var>{path}</Var>
                </T>
              </p>
            ))}
        </>
      )}
    </section>
  );
};
