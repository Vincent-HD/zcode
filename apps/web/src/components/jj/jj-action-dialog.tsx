import {
  JjBookmarkName,
  type EnvironmentId,
  type JjLogRow,
  type JjRunAction,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react";
import { PenLineIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import type { MessageResolver } from "~/i18n/messages";
import { jjEnvironment } from "~/state/jj";
import { useAtomCommand } from "~/state/use-atom-command";
import { jjSquashTargets, type JjDialogRequest } from "./jj-actions";

const isBookmarkName = Schema.is(JjBookmarkName);

const revisionLabel = (row: JjLogRow, resolve: MessageResolver) =>
  `${row.changeId.slice(0, 8)} · ${row.summary || resolve(msg("(no description)"))}`;

const ancestorBookmarks = (input: { revision: JjLogRow; rows: ReadonlyArray<JjLogRow> }) => {
  const byId = new Map(input.rows.map((row) => [row.commitId, row]));
  const names: string[] = [];
  const seen = new Set<string>();
  const pending = [...input.revision.parentIds];
  while (pending.length) {
    const id = pending.shift();
    const row = id ? byId.get(id) : undefined;
    if (!row || seen.has(row.commitId)) continue;
    seen.add(row.commitId);
    names.push(...(row.bookmarks ?? []));
    pending.push(...row.parentIds);
  }
  return [...new Set(names)];
};

const CommitMessage = (props: {
  environmentId: EnvironmentId;
  cwd: string;
  revision: JjLogRow;
  disabled: boolean;
  value: string | null;
  onChange: (value: string) => void;
  /** Writes the message with T3's text generation; absent where it is unavailable. */
  onGenerate?: (() => Promise<string>) | undefined;
}) => {
  const gt = useGT();
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const getRevision = useAtomCommand(jjEnvironment.getRevision, {
    reportFailure: false,
    reportDefect: false,
  });
  const { environmentId, cwd, onChange } = props;
  const commitId = props.revision.commitId;
  const prefilled = props.value !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prefills the message from the remote revision's full description once
  useEffect(() => {
    if (prefilled) return;
    let cancelled = false;
    void getRevision({ environmentId, input: { cwd, commitId } }).then((result) => {
      if (!cancelled) onChange(result._tag === "Success" ? result.value.description : "");
    });
    return () => {
      cancelled = true;
    };
  }, [getRevision, environmentId, cwd, commitId, prefilled, onChange]);
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`jj-commit-message-${commitId}`}>
          <T>Description for the working copy</T>
        </label>
        {props.onGenerate ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={props.disabled || generating}
            onClick={() => {
              const generate = props.onGenerate;
              if (!generate) return;
              setGenerating(true);
              setGenerateError(null);
              generate()
                .then(onChange)
                .catch((error: unknown) =>
                  setGenerateError(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setGenerating(false));
            }}
          >
            <PenLineIcon aria-hidden />
            {generating ? gt("Generating…") : gt("Generate")}
          </Button>
        ) : null}
      </div>
      <Textarea
        id={`jj-commit-message-${commitId}`}
        autoFocus
        value={props.value ?? ""}
        placeholder={props.value === null ? gt("Loading description…") : gt("Describe this change")}
        disabled={props.disabled || props.value === null || generating}
        onChange={(event) => onChange(event.target.value)}
      />
      {generateError ? <p className="text-destructive">{generateError}</p> : null}
    </div>
  );
};

export const JjActionDialog = (props: {
  request: JjDialogRequest<JjLogRow>;
  environmentId: EnvironmentId;
  cwd: string;
  rows: ReadonlyArray<JjLogRow>;
  remotes: ReadonlyArray<string>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (action: JjRunAction, title: string) => void;
  onGenerateCommitMessage?: (() => Promise<string>) | undefined;
}) => {
  const gt = useGT();
  const messages = useMessages();
  const { request } = props;
  const [targetCommitId, setTargetCommitId] = useState<string | null>(null);
  const [bookmarkName, setBookmarkName] = useState(() =>
    request.kind === "bookmark" && request.mode === "set"
      ? (request.revision.bookmarks?.[0] ?? "")
      : request.kind === "bookmark"
        ? (ancestorBookmarks({ revision: request.revision, rows: props.rows })[0] ?? "")
        : "",
  );
  const [pushNames, setPushNames] = useState<ReadonlyArray<string>>(() =>
    request.kind === "push" ? (request.revision.bookmarks ?? []) : [],
  );
  const [remote, setRemote] = useState(() =>
    props.remotes.includes("origin") ? "origin" : (props.remotes[0] ?? ""),
  );
  const [message, setMessage] = useState<string | null>(null);

  const plan = ((): {
    title: string;
    description: string;
    confirmLabel: string;
    destructive: boolean;
    action: JjRunAction | null;
  } => {
    switch (request.kind) {
      case "confirm":
        return { ...request, action: request.action };
      case "squash-ancestor": {
        const target = targetCommitId;
        return {
          title: request.paths?.length
            ? gt("Squash file into ancestor")
            : gt("Squash into ancestor"),
          description: gt(
            "Moves the changes into the chosen mutable ancestor and keeps its description. An emptied source is abandoned.",
          ),
          confirmLabel: gt("Squash", { $context: "verb, confirms a squash" }),
          destructive: false,
          action: target
            ? {
                type: "squash",
                sourceCommitId: request.source.commitId,
                destinationCommitId: target,
                mode: "into",
                ...(request.paths?.length ? { paths: [...request.paths] } : {}),
              }
            : null,
        };
      }
      case "bookmark": {
        const name = bookmarkName.trim();
        const valid = isBookmarkName(name);
        return request.mode === "set"
          ? {
              title: gt("Set bookmark"),
              description: gt(
                "Creates the local bookmark on {revision}, or moves an existing one there.",
                { revision: revisionLabel(request.revision, messages) },
              ),
              confirmLabel: gt("Set bookmark"),
              destructive: false,
              action: valid
                ? { type: "bookmark-set", name, revisionCommitId: request.revision.commitId }
                : null,
            }
          : {
              title: gt("Advance bookmark"),
              description: gt("Moves a bookmark forward from an ancestor to {revision}.", {
                revision: revisionLabel(request.revision, messages),
              }),
              confirmLabel: gt("Advance bookmark"),
              destructive: false,
              action: valid
                ? { type: "bookmark-advance", name, revisionCommitId: request.revision.commitId }
                : null,
            };
      }
      case "push":
        return {
          title: gt("Push bookmarks"),
          description: gt(
            "Publishes only the chosen bookmarks to the remote. Undo cannot reverse a push.",
          ),
          confirmLabel: gt("Push", { $context: "verb, pushes bookmarks to a remote" }),
          destructive: false,
          action:
            pushNames.length && isBookmarkName(remote)
              ? { type: "push", bookmarkNames: [...pushNames], remote }
              : null,
        };
      case "commit":
        return {
          title: gt("Commit working copy"),
          description: gt(
            "Saves the description on the working copy and starts a new empty change on top.",
          ),
          confirmLabel: gt("Commit", { $context: "verb" }),
          destructive: false,
          action: message === null ? null : { type: "commit", description: message },
        };
    }
  })();

  const squashTargets =
    request.kind === "squash-ancestor"
      ? jjSquashTargets({ source: request.source, rows: props.rows, scope: "ancestors" })
      : [];
  const allBookmarks = [...new Set(props.rows.flatMap((row) => row.bookmarks ?? []))];
  const suggestions =
    request.kind === "bookmark"
      ? request.mode === "advance"
        ? ancestorBookmarks({ revision: request.revision, rows: props.rows })
        : allBookmarks
      : [];

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{plan.title}</AlertDialogTitle>
          <AlertDialogDescription>{plan.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto px-6 pb-2 text-sm">
          {request.kind === "squash-ancestor" && (
            <fieldset disabled={props.busy} className="space-y-1">
              <legend className="mb-1 text-xs font-medium">
                {request.paths?.length
                  ? gt("Destination for {paths}", { paths: request.paths.join(", ") })
                  : gt("Destination")}
              </legend>
              {squashTargets.map((row) => (
                <Button
                  key={row.commitId}
                  size="xs"
                  variant={targetCommitId === row.commitId ? "default" : "outline"}
                  aria-pressed={targetCommitId === row.commitId}
                  onClick={() => setTargetCommitId(row.commitId)}
                >
                  <span className="truncate">{revisionLabel(row, messages)}</span>
                </Button>
              ))}
              {squashTargets.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  <T>
                    No mutable, conflict-free ancestor is loaded. Load more revisions or widen the
                    revset.
                  </T>
                </p>
              )}
            </fieldset>
          )}
          {request.kind === "bookmark" && (
            <div className="space-y-2 text-xs">
              <label className="block space-y-1">
                <span>
                  <T>Bookmark name</T>
                </span>
                <Input
                  autoFocus
                  value={bookmarkName}
                  disabled={props.busy}
                  onChange={(event) => setBookmarkName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && plan.action) {
                      event.preventDefault();
                      props.onConfirm(plan.action, plan.confirmLabel);
                    }
                  }}
                />
              </label>
              {bookmarkName.trim() && !isBookmarkName(bookmarkName.trim()) && (
                <p className="text-destructive">
                  <T>Use letters, digits, “.”, “_”, “-” and “/”.</T>
                </p>
              )}
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {suggestions.map((name) => (
                    <Button
                      key={name}
                      size="xs"
                      variant={bookmarkName === name ? "secondary" : "outline"}
                      onClick={() => setBookmarkName(name)}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
          {request.kind === "push" && (
            <div className="space-y-2 text-xs">
              <fieldset className="space-y-1">
                <legend className="mb-1 font-medium">
                  <T>Bookmarks</T>
                </legend>
                {allBookmarks.map((name) => (
                  <label key={name} className="flex items-center gap-2">
                    <Checkbox
                      checked={pushNames.includes(name)}
                      disabled={props.busy}
                      onCheckedChange={(checked) =>
                        setPushNames((names) =>
                          checked ? [...names, name] : names.filter((value) => value !== name),
                        )
                      }
                    />
                    <span className="break-all font-mono">{name}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="space-y-1">
                <legend className="mb-1 font-medium">
                  <T context="a Git remote">Remote</T>
                </legend>
                {props.remotes.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {props.remotes.map((name) => (
                      <Button
                        key={name}
                        size="xs"
                        variant={remote === name ? "default" : "outline"}
                        aria-pressed={remote === name}
                        disabled={props.busy}
                        onClick={() => setRemote(name)}
                      >
                        {name}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    <T>This repository has no Git remotes.</T>
                  </p>
                )}
              </fieldset>
            </div>
          )}
          {request.kind === "commit" && (
            <CommitMessage
              environmentId={props.environmentId}
              cwd={props.cwd}
              revision={request.revision}
              disabled={props.busy}
              value={message}
              onChange={setMessage}
              onGenerate={props.onGenerateCommitMessage}
            />
          )}
          {props.error && (
            <p role="alert" className="text-xs text-destructive">
              {props.error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
            <T>Cancel</T>
          </Button>
          <Button
            variant={plan.destructive ? "destructive" : "default"}
            disabled={props.busy || !plan.action}
            onClick={() => {
              if (plan.action) props.onConfirm(plan.action, plan.confirmLabel);
            }}
          >
            {props.busy ? gt("Applying…") : plan.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
