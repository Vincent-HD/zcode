import type { EnvironmentId, JjPanelReady, JjRevision, JjRunActionInput } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "~/components/ui/alert-dialog";
import {
  buildJjPanelAction,
  jjActionLabels,
  selectableJjTargets,
  jjSquashTargets,
  type JjActionFields,
  type JjPanelActionKind,
} from "./jj-panel-state";

export interface JjActionPreview {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly panel: JjPanelReady;
  readonly kind: JjPanelActionKind;
  readonly source: JjRevision;
  readonly selectedCommitIds: string[];
  readonly paths: string[];
  readonly squashScope?: "parent" | "ancestors";
}

const explanations: Record<JjPanelActionKind, string> = {
  new: "Create an empty child of the chosen parents and make it the working copy.",
  commit: "Save this message on the working copy and start a new empty child.",
  edit: "Switch the working copy to this older revision. Subsequent edits change that revision.",
  "insert-before": "Insert an empty revision before these revisions, rewriting their parentage.",
  "insert-after": "Insert an empty revision after these revisions, rewriting their descendants.",
  "squash-into":
    "Move source changes into a mutable destination. An emptied source may be abandoned.",
  "squash-onto":
    "Move source changes into a new child of the destination. The destination stays unchanged.",
  absorb:
    "Distribute source changes to the mutable ancestors that last changed those lines. Unmatched changes stay in the source.",
  "rebase-revision": "Move this revision onto the chosen parents and reconnect its descendants.",
  "rebase-branch": "Move this revision and its branch onto the chosen parents.",
  duplicate:
    "Copy this revision. Choose destination parents, or leave them unchecked to keep its original parents.",
  merge: "Create an empty working-copy revision with all selected parents.",
  abandon: "Remove these revisions from history and rebase their descendants.",
  restore: "Discard these changes in the source revision, restoring files from its merged parents.",
  undo: "Undo the latest workspace operation, including operations performed outside this panel.",
  redo: "Redo the most recently undone workspace operation.",
  "bookmark-set": "Create a local bookmark or move an existing bookmark to this revision.",
  "bookmark-delete":
    "Delete this local bookmark. Publishing the deletion requires an explicit push.",
  "bookmark-advance": "Advance this local bookmark to the selected descendant revision.",
  push: "Publish only the named bookmarks to the chosen remote. Undo cannot reverse remote publication.",
};

export const jjTargetRevisions = (panel: JjPanelReady) => [
  ...new Map(
    [...panel.revisions, ...(panel.visibleRevisions ?? [])].map((revision) => [
      revision.commitId,
      revision,
    ]),
  ).values(),
];

const revisionLabel = (revision: JjRevision) =>
  `${revision.changeId.slice(0, 8)} · ${revision.description.split("\n")[0] || "(no description)"}`;

export const JjActionDialog = (props: {
  preview: JjActionPreview;
  visible: boolean;
  blocked: boolean;
  busy: boolean;
  revertingPanelAction?: boolean;
  stale: boolean;
  dirtyWorkingCopy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (action: JjRunActionInput["action"]) => void;
}) => {
  const preview = props.preview;
  const revisions = jjTargetRevisions(preview.panel);
  const targets = preview.squashScope
    ? jjSquashTargets({ source: preview.source, revisions, scope: preview.squashScope })
    : selectableJjTargets({
        kind: preview.kind,
        sourceCommitId: preview.source.commitId,
        revisions,
      });
  const pushableBookmarks = revisions.flatMap((revision) =>
    (revision.bookmarks ?? []).map((name) => ({ name, changeId: revision.changeId })),
  );
  const remotes = preview.panel.remotes ?? [];
  const [fields, setFields] = useState<JjActionFields>(() => ({
    targetCommitIds:
      preview.kind === "new" || preview.kind === "merge"
        ? preview.selectedCommitIds.length
          ? preview.selectedCommitIds
          : [preview.source.commitId]
        : preview.squashScope === "parent" && targets.length === 1
          ? [targets[0]!.commitId]
          : [],
    paths: preview.paths,
    allFiles: preview.paths.length === 0,
    description: preview.source.description,
    replaceMessage: false,
    bookmarkName: preview.source.bookmarks?.[0] ?? "",
    bookmarkNames: [
      ...new Set(
        revisions
          .filter(
            (revision) =>
              revision.commitId === preview.source.commitId ||
              preview.selectedCommitIds.includes(revision.commitId),
          )
          .flatMap((revision) => revision.bookmarks ?? []),
      ),
    ],
    remote: remotes.includes("origin") ? "origin" : (remotes[0] ?? ""),
  }));
  const update = (next: Partial<JjActionFields>) =>
    setFields((current) => ({ ...current, ...next }));
  const choosesTargets = [
    "new",
    "merge",
    "squash-into",
    "squash-onto",
    "rebase-revision",
    "rebase-branch",
    "duplicate",
  ].includes(preview.kind);
  const choosesFiles = ["squash-into", "squash-onto", "absorb", "restore"].includes(preview.kind);
  const squashing = preview.kind === "squash-into" || preview.kind === "squash-onto";
  const bookmarkAction = preview.kind.startsWith("bookmark-");
  const action = buildJjPanelAction({
    kind: preview.kind,
    sourceCommitId: preview.source.commitId,
    selectedCommitIds: preview.selectedCommitIds,
    fields,
    revisions,
    workingCopyCommitId: preview.panel.workingCopyCommitId,
    filesTruncated: preview.panel.filesTruncated,
  });
  const selected = preview.selectedCommitIds.length
    ? preview.selectedCommitIds
    : [preview.source.commitId];
  return (
    <AlertDialog
      open={props.visible}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {props.revertingPanelAction
              ? "Revert last panel action"
              : preview.squashScope
                ? `Squash into ${preview.squashScope === "parent" ? "parent" : "ancestor"}`
                : jjActionLabels[preview.kind]}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {props.revertingPanelAction
              ? "Revert only the last action performed by this panel. This is unavailable after an intervening operation."
              : explanations[preview.kind]}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto px-6 pb-6 text-sm">
          <div className="space-y-1 text-xs">
            <p className="break-all">Workspace: {preview.panel.workspaceIdentity.workspaceRoot}</p>
            <p className="break-all font-mono">
              Operation: {preview.panel.operationId.slice(0, 16)}
            </p>
            {!["undo", "redo", "push", "bookmark-delete"].includes(preview.kind) && (
              <>
                <p className="break-words">Source: {revisionLabel(preview.source)}</p>
                <p className="break-all font-mono">Commit: {preview.source.commitId}</p>
              </>
            )}
            {["abandon", "insert-before", "insert-after"].includes(preview.kind) && (
              <>
                <p>Selected revisions:</p>
                {selected.map((id) => (
                  <p key={id} className="break-all font-mono">
                    {revisionLabel(
                      revisions.find((revision) => revision.commitId === id) ?? preview.source,
                    )}{" "}
                    · {id}
                  </p>
                ))}
              </>
            )}
          </div>
          {choosesTargets && (
            <fieldset disabled={props.busy} className="space-y-2">
              <legend className="mb-1 text-xs font-medium">
                {squashing ? "Destination" : "Destination parents"}
              </legend>
              <div className="max-h-44 space-y-2 overflow-y-auto">
                {targets.map((revision) => (
                  <label key={revision.commitId} className="flex items-start gap-2 text-xs">
                    <Checkbox
                      disabled={props.busy}
                      checked={fields.targetCommitIds.includes(revision.commitId)}
                      onCheckedChange={(checked) => {
                        update({
                          targetCommitIds: squashing
                            ? checked
                              ? [revision.commitId]
                              : []
                            : checked
                              ? [...fields.targetCommitIds, revision.commitId]
                              : fields.targetCommitIds.filter((id) => id !== revision.commitId),
                        });
                      }}
                    />
                    <span className="min-w-0 break-words">
                      {revisionLabel(revision)}
                      {revision.immutable ? " · immutable" : ""}
                      <span className="block break-all font-mono text-muted-foreground">
                        {revision.commitId}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {preview.panel.visibleRevisionsTruncated && (
                <p className="text-xs text-muted-foreground">
                  Available target list is truncated. Refresh after changing the workspace to select
                  other revisions.
                </p>
              )}
            </fieldset>
          )}
          {choosesTargets && fields.targetCommitIds.length > 0 && (
            <div className="space-y-1 text-xs">
              <p className="font-medium">
                Selected destination{fields.targetCommitIds.length > 1 ? "s" : ""}:
              </p>
              {fields.targetCommitIds.map((id) => (
                <p key={id} className="break-all">
                  {revisions
                    .find((revision) => revision.commitId === id)
                    ?.description.split("\n")[0] || "(no description)"}{" "}
                  · <span className="font-mono">{id}</span>
                </p>
              ))}
            </div>
          )}
          {preview.kind === "absorb" && (
            <p className="text-xs">
              Destination: mutable, conflict-free ancestors of{" "}
              <span className="font-mono">{preview.source.changeId.slice(0, 8)}</span>, selected by
              line history.
            </p>
          )}
          {preview.kind === "restore" && (
            <p className="break-all text-xs">
              Restore source revision from merged parents:{" "}
              <span className="font-mono">{preview.source.parentIds.join(", ")}</span>
            </p>
          )}
          {preview.kind === "duplicate" && fields.targetCommitIds.length === 0 && (
            <p className="break-all text-xs">
              Keep original destination parents:{" "}
              <span className="font-mono">{preview.source.parentIds.join(", ")}</span>
            </p>
          )}
          {choosesFiles && (
            <fieldset disabled={props.busy} className="space-y-2">
              <legend className="mb-1 text-xs font-medium">Files moved / restored</legend>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  disabled={props.busy}
                  checked={fields.allFiles}
                  onCheckedChange={(checked) => update({ allFiles: checked })}
                />
                All changed files
              </label>
              <div className="max-h-36 space-y-2 overflow-y-auto">
                {preview.source.files.map((file) => (
                  <label key={file.path} className="flex items-start gap-2 text-xs">
                    {!fields.allFiles && (
                      <Checkbox
                        disabled={props.busy}
                        checked={fields.paths.includes(file.path)}
                        onCheckedChange={(checked) =>
                          update({
                            paths: checked
                              ? [...fields.paths, file.path]
                              : fields.paths.filter((path) => path !== file.path),
                          })
                        }
                      />
                    )}
                    <span className="break-all font-mono">{file.path}</span>
                  </label>
                ))}
              </div>
              {preview.panel.filesTruncated && (
                <p className="text-xs text-muted-foreground">
                  The file list is truncated.
                  {preview.kind === "restore" && fields.allFiles
                    ? " Restore all is unavailable; choose specific listed files."
                    : " All files includes files beyond this list."}
                </p>
              )}
            </fieldset>
          )}
          {squashing && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={fields.replaceMessage}
                  disabled={props.busy}
                  onCheckedChange={(checked) => update({ replaceMessage: checked })}
                />
                Replace resulting description
              </label>
              {!fields.replaceMessage && (
                <p className="text-xs text-muted-foreground">
                  {preview.kind === "squash-into"
                    ? "Keep the destination description; discard the source description."
                    : "Keep the source description on the new child."}
                </p>
              )}
            </>
          )}
          {(preview.kind === "commit" || (squashing && fields.replaceMessage)) && (
            <label className="block space-y-1 text-xs">
              <span>Resulting description</span>
              <Textarea
                value={fields.description}
                disabled={props.busy}
                onChange={(event) => update({ description: event.target.value })}
              />
            </label>
          )}
          {bookmarkAction && (
            <label className="block space-y-1 text-xs">
              <span>Local bookmark name</span>
              <Input
                value={fields.bookmarkName}
                disabled={props.busy}
                onChange={(event) => update({ bookmarkName: event.target.value })}
              />
            </label>
          )}
          {preview.kind === "push" && (
            <>
              <fieldset className="space-y-1 text-xs">
                <legend>Bookmarks to publish</legend>
                {pushableBookmarks.length === 0 && (
                  <p className="text-muted-foreground">
                    No local bookmarks on the loaded revisions. Set a bookmark first.
                  </p>
                )}
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {pushableBookmarks.map((bookmark) => (
                    <label key={bookmark.name} className="flex items-center gap-2">
                      <Checkbox
                        checked={fields.bookmarkNames.includes(bookmark.name)}
                        disabled={props.busy}
                        onCheckedChange={(checked) =>
                          update({
                            bookmarkNames: checked
                              ? [...fields.bookmarkNames, bookmark.name]
                              : fields.bookmarkNames.filter((name) => name !== bookmark.name),
                          })
                        }
                      />
                      <span className="break-all font-mono">{bookmark.name}</span>
                      <span className="font-mono text-muted-foreground">
                        {bookmark.changeId.slice(0, 8)}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {remotes.length > 0 ? (
                <fieldset className="space-y-1 text-xs">
                  <legend>Remote</legend>
                  <div className="flex flex-wrap gap-1">
                    {remotes.map((remote) => (
                      <Button
                        key={remote}
                        size="xs"
                        variant={fields.remote === remote ? "default" : "outline"}
                        aria-pressed={fields.remote === remote}
                        disabled={props.busy}
                        onClick={() => update({ remote })}
                      >
                        {remote}
                      </Button>
                    ))}
                  </div>
                </fieldset>
              ) : (
                <label className="block space-y-1 text-xs">
                  <span>Remote</span>
                  <Input
                    value={fields.remote}
                    disabled={props.busy}
                    onChange={(event) => update({ remote: event.target.value })}
                  />
                </label>
              )}
              <p className="break-words text-xs">
                Publish: {fields.bookmarkNames.filter(Boolean).join(", ") || "(choose bookmarks)"} →{" "}
                {fields.remote || "(choose remote)"}
              </p>
            </>
          )}
          {props.dirtyWorkingCopy && (
            <p role="alert" className="text-xs text-warning-foreground">
              Save or cancel the working-copy description draft before running an action.
            </p>
          )}
          {props.stale && (
            <p role="alert" className="text-xs text-destructive">
              The workspace or operation changed. Cancel and select the action again.
            </p>
          )}
          {!action && (
            <p className="text-xs text-muted-foreground">
              Choose valid targets, files, and names before confirming.
            </p>
          )}
          {props.error && (
            <p role="alert" className="text-xs text-destructive">
              {props.error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant={
              preview.kind === "abandon" ||
              preview.kind === "restore" ||
              preview.kind === "bookmark-delete"
                ? "destructive"
                : "default"
            }
            disabled={props.blocked || props.stale || props.dirtyWorkingCopy || !action}
            onClick={() => {
              if (action) props.onConfirm(action);
            }}
          >
            {props.busy
              ? "Applying…"
              : `Confirm ${props.revertingPanelAction ? "revert panel action" : jjActionLabels[preview.kind].toLowerCase()}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
