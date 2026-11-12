import type {
  EnvironmentId,
  JjLogRow,
  JjRevisionDetails,
  JjRunAction,
  JjSignature,
} from "@t3tools/contracts";
import { ArrowDown, ChevronsDown, FileDiff, Undo2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { jjEnvironment } from "~/state/jj";
import { useAtomCommand } from "~/state/use-atom-command";
import type { JjDialogRequest } from "./jj-actions";
import { JjChangeId, JjHint, JjRefPills, JjRelativeTime } from "./jj-graph-rows";
import {
  descriptionDraftIsStale,
  formatJjPanelError,
  type DescriptionDraft,
} from "./jj-panel-state";

const STATUS_LETTERS = { added: "A", modified: "M", removed: "D", renamed: "R", copied: "C" };
const STATUS_COLORS = {
  added: "text-diff-addition-foreground",
  removed: "text-destructive",
  modified: "text-warning-foreground",
  renamed: "text-warning-foreground",
  copied: "text-warning-foreground",
};

const IconAction = (props: {
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
          aria-label={props.label}
          disabled={props.disabled}
          onClick={props.onClick}
        />
      }
    >
      {props.icon}
    </TooltipTrigger>
    <TooltipPopup>{props.label}</TooltipPopup>
  </Tooltip>
);

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
  const { row } = props;
  const { resolvedTheme } = useTheme();
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
    <section aria-label="Revision details" className="space-y-2 px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <JjHint
          label="Copy change ID"
          render={
            <button
              type="button"
              aria-label="Copy change ID"
              className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => props.onCopy(row.changeId, "Change ID")}
            />
          }
        >
          <JjChangeId row={row} length={12} />
        </JjHint>
        <JjHint
          label="Copy commit ID"
          render={
            <button
              type="button"
              aria-label="Copy commit ID"
              className="rounded-sm font-mono text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => props.onCopy(row.commitId, "Commit ID")}
            />
          }
        >
          {row.commitId.slice(0, Math.max(8, row.commitPrefixLength))}
        </JjHint>
        {row.current && (
          <Badge size="sm" variant="info">
            working copy
          </Badge>
        )}
        {locked && (
          <Badge size="sm" variant="secondary">
            immutable
          </Badge>
        )}
        {row.empty && !row.root && (
          <Badge size="sm" variant="outline">
            empty
          </Badge>
        )}
        {row.conflict && (
          <Badge size="sm" variant="error">
            conflicted
          </Badge>
        )}
        {row.divergent && (
          <Badge size="sm" variant="warning">
            divergent
          </Badge>
        )}
        {row.hidden && (
          <Badge size="sm" variant="outline">
            hidden
          </Badge>
        )}
        <JjRefPills row={row} />
      </div>
      {current?.error && (
        <p role="alert" className="text-destructive">
          {current.error}
        </p>
      )}
      {!current && <p className="text-muted-foreground">Loading revision…</p>}
      {details && (
        <>
          <div className="space-y-0.5">
            <Signature label="Author" signature={details.author} />
            {(details.committer.email !== details.author.email ||
              details.committer.timestamp !== details.author.timestamp) && (
              <Signature label="Committer" signature={details.committer} />
            )}
          </div>
          {editing && !locked ? (
            <div className="space-y-1.5">
              <Textarea
                size="sm"
                autoFocus
                aria-label={`Description for ${row.changeId.slice(0, 8)}`}
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
                  This revision changed after you started editing. Discard to load its current
                  description.
                </p>
              )}
              <div className="flex gap-1">
                <Button
                  size="xs"
                  disabled={props.busy || !props.canDescribe || stale || !dirty}
                  onClick={save}
                >
                  Save description
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
                  Discard
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
                {details.description.trimEnd() || "(no description)"}
              </p>
              {!locked && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.busy || !props.canDescribe}
                  onClick={() => setEditing(true)}
                >
                  {dirty ? "Resume draft" : "Describe"}
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground">
              {details.files.length}
              {details.filesTruncated ? "+" : ""} changed file
              {details.files.length === 1 ? "" : "s"}
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={!props.canDiff || details.files.length === 0}
              onClick={() => props.onOpenDiff({ commitId: row.commitId })}
            >
              <FileDiff />
              Show diff
            </Button>
          </div>
          <ul className="space-y-0.5">
            {details.files.map((file) => (
              <li
                key={file.path}
                className="group/file flex h-7 min-w-0 items-center gap-1 rounded hover:bg-accent/50"
              >
                <JjHint
                  label={`${file.path} · ${file.status}`}
                  render={
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 ps-1 text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                      disabled={!props.canDiff}
                      onClick={() =>
                        props.onOpenDiff({ commitId: row.commitId, filePath: file.path })
                      }
                    />
                  }
                >
                  <PierreEntryIcon pathValue={file.path} kind="file" theme={resolvedTheme} />
                  <span className="truncate">{file.path}</span>
                  {details.conflictPaths.includes(file.path) && (
                    <span className="shrink-0 text-destructive">conflict</span>
                  )}
                </JjHint>
                {!locked && (
                  <div className="flex shrink-0 opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100">
                    <IconAction
                      label="Restore file"
                      icon={<Undo2 />}
                      disabled={fileActionsDisabled}
                      onClick={() =>
                        props.onDialog({
                          kind: "confirm",
                          title: `Restore ${file.path}?`,
                          description:
                            "Discards this revision's changes to the file, restoring it from the parent. Undo brings them back.",
                          confirmLabel: "Restore",
                          destructive: true,
                          action: {
                            type: "restore",
                            revisionCommitId: row.commitId,
                            paths: [file.path],
                          },
                        })
                      }
                    />
                    <IconAction
                      label="Squash file into ancestor"
                      icon={<ChevronsDown />}
                      disabled={
                        fileActionsDisabled || row.conflict === true || !props.hasSquashAncestor
                      }
                      onClick={() =>
                        props.onDialog({ kind: "squash-ancestor", source: row, paths: [file.path] })
                      }
                    />
                    <IconAction
                      label="Squash file into parent"
                      icon={<ArrowDown />}
                      disabled={
                        fileActionsDisabled ||
                        row.conflict === true ||
                        row.parentIds.length !== 1 ||
                        Boolean(props.parent && (props.parent.immutable || props.parent.conflict))
                      }
                      onClick={() =>
                        props.onRun(
                          {
                            type: "squash",
                            sourceCommitId: row.commitId,
                            destinationCommitId: row.parentIds[0] ?? "",
                            mode: "into",
                            paths: [file.path],
                          },
                          "File squashed into parent",
                        )
                      }
                    />
                  </div>
                )}
                <span
                  className={`w-3 shrink-0 text-center ${STATUS_COLORS[file.status]}`}
                  aria-label={file.status}
                >
                  {STATUS_LETTERS[file.status]}
                </span>
              </li>
            ))}
          </ul>
          {details.conflictPaths
            .filter((path) => !details.files.some((file) => file.path === path))
            .map((path) => (
              <p key={path} className="break-all text-destructive">
                Conflict · {path}
              </p>
            ))}
        </>
      )}
    </section>
  );
};
