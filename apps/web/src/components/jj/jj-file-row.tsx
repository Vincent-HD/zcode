import type { JjChangedFile, JjLogRow, JjRunAction } from "@t3tools/contracts";
import { ArrowDown, ChevronsDown, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import type { JjDialogRequest } from "./jj-actions";
import { JjHint } from "./jj-graph-rows";

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

/** One changed file: opens its diff on click and shows hover actions when given. */
export const JjFileRow = (props: {
  file: JjChangedFile;
  conflict: boolean;
  canDiff: boolean;
  onOpenDiff: () => void;
  actions?: ReactNode;
}) => {
  const { resolvedTheme } = useTheme();
  const { file } = props;
  return (
    <li className="group/file flex h-7 min-w-0 items-center gap-1 rounded hover:bg-accent/50">
      <JjHint
        label={`${file.path} · ${file.status}`}
        render={
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 ps-1 text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
            disabled={!props.canDiff}
            onClick={props.onOpenDiff}
          />
        }
      >
        <PierreEntryIcon pathValue={file.path} kind="file" theme={resolvedTheme} />
        <span className="truncate">{file.path}</span>
        {props.conflict && <span className="shrink-0 text-destructive">conflict</span>}
      </JjHint>
      {props.actions && (
        <div className="flex shrink-0 opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100">
          {props.actions}
        </div>
      )}
      <span
        className={`w-3 shrink-0 text-center ${STATUS_COLORS[file.status]}`}
        aria-label={file.status}
      >
        {STATUS_LETTERS[file.status]}
      </span>
    </li>
  );
};

/** Restore and squash actions for one file of a mutable revision. */
export const JjFileActions = (props: {
  commitId: string;
  path: string;
  disabled: boolean;
  /** The parent the file can squash into, when that is allowed. */
  squashParentId: string | undefined;
  /** Omitted where picking an ancestor is not offered. */
  squashAncestor?: { enabled: boolean; onClick: () => void };
  onRun: (action: JjRunAction, title: string) => void;
  onDialog: (request: JjDialogRequest<JjLogRow>) => void;
}) => (
  <>
    <IconAction
      label="Restore file"
      icon={<Undo2 />}
      disabled={props.disabled}
      onClick={() =>
        props.onDialog({
          kind: "confirm",
          title: `Restore ${props.path}?`,
          description:
            "Discards this revision's changes to the file, restoring it from the parent. Undo brings them back.",
          confirmLabel: "Restore",
          destructive: true,
          action: { type: "restore", revisionCommitId: props.commitId, paths: [props.path] },
        })
      }
    />
    {props.squashAncestor && (
      <IconAction
        label="Squash file into ancestor"
        icon={<ChevronsDown />}
        disabled={props.disabled || !props.squashAncestor.enabled}
        onClick={props.squashAncestor.onClick}
      />
    )}
    <IconAction
      label="Squash file into parent"
      icon={<ArrowDown />}
      disabled={props.disabled || props.squashParentId === undefined}
      onClick={() =>
        props.squashParentId &&
        props.onRun(
          {
            type: "squash",
            sourceCommitId: props.commitId,
            destinationCommitId: props.squashParentId,
            mode: "into",
            paths: [props.path],
          },
          "File squashed into parent",
        )
      }
    />
  </>
);
