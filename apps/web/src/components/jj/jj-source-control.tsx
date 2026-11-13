import type { JjLogRow, JjRunAction, JjSourceControlGroup } from "@t3tools/contracts";
import { ChevronDown, FileDiff } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { JjDialogRequest } from "./jj-actions";
import { JjFileActions, JjFileRow } from "./jj-file-row";
import { JjChangeId, JjHint } from "./jj-graph-rows";

const GroupHeader = (props: {
  group: JjSourceControlGroup;
  expanded: boolean;
  active: boolean;
  canDiff: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onOpenDiff: () => void;
}) => {
  const { group } = props;
  const label = group.position === "@" ? "Working copy" : group.position;
  return (
    <div
      className={cn(
        "group/header flex h-7 min-w-0 items-center gap-1 rounded pe-1 hover:bg-accent/50",
        props.active && "bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-label={`${props.expanded ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={props.expanded}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={props.onToggle}
      >
        <ChevronDown className={cn("size-3", !props.expanded && "-rotate-90")} />
      </button>
      <JjHint
        label={group.summary || "(no description)"}
        render={
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
            onClick={props.onSelect}
          />
        }
      >
        <span className="shrink-0 font-medium">{label}</span>
        <JjChangeId row={group} />
        <span className={cn("truncate", !group.summary && "text-muted-foreground italic")}>
          {group.summary || "(no description)"}
        </span>
        {group.conflict && <span className="shrink-0 text-destructive">conflict</span>}
      </JjHint>
      <span className="flex shrink-0 opacity-0 group-hover/header:opacity-100 group-focus-within/header:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Show diff of ${label}`}
          disabled={!props.canDiff || group.files.length === 0}
          onClick={props.onOpenDiff}
        >
          <FileDiff />
        </Button>
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {group.files.length}
        {group.filesTruncated ? "+" : ""}
      </span>
    </div>
  );
};

/** jj-view's source control view: the working copy and its mutable ancestors with their files. */
export const JjSourceControl = (props: {
  groups: ReadonlyArray<JjSourceControlGroup>;
  activeChangeId: string | null;
  canWrite: boolean;
  canDiff: boolean;
  onSelect: (changeId: string) => void;
  onOpenDiff: (input: { commitId: string; filePath?: string }) => void;
  onRun: (action: JjRunAction, title: string) => void;
  onDialog: (request: JjDialogRequest<JjLogRow>) => void;
}) => {
  // Keyed by change id so a group stays collapsed while its commit is rewritten.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const workingCopy = props.groups[0];
  const conflicts = workingCopy?.conflictPaths ?? [];
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <ul aria-label="Source control" className="space-y-0.5 px-1 py-1 text-xs">
      {workingCopy && conflicts.length > 0 && (
        <li>
          <div className="flex h-7 items-center gap-1 px-1 font-medium text-destructive">
            <button
              type="button"
              aria-label={`${collapsed.has("conflicts") ? "Expand" : "Collapse"} merge conflicts`}
              aria-expanded={!collapsed.has("conflicts")}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => toggle("conflicts")}
            >
              <ChevronDown className={cn("size-3", collapsed.has("conflicts") && "-rotate-90")} />
            </button>
            <span className="flex-1">Merge conflicts</span>
            <span className="tabular-nums">{conflicts.length}</span>
          </div>
          {!collapsed.has("conflicts") && (
            <ul className="ps-4">
              {conflicts.map((path) => (
                <JjFileRow
                  key={path}
                  file={
                    workingCopy.files.find((file) => file.path === path) ?? {
                      path,
                      status: "modified",
                    }
                  }
                  conflict
                  canDiff={props.canDiff}
                  onOpenDiff={() =>
                    props.onOpenDiff({ commitId: workingCopy.commitId, filePath: path })
                  }
                />
              ))}
            </ul>
          )}
        </li>
      )}
      {props.groups.map((group) => {
        const expanded = !collapsed.has(group.changeId);
        const squashParentId = group.squashable && !group.conflict ? group.parentIds[0] : undefined;
        return (
          <li key={group.changeId}>
            <GroupHeader
              group={group}
              expanded={expanded}
              active={props.activeChangeId === group.changeId}
              canDiff={props.canDiff}
              onToggle={() => toggle(group.changeId)}
              onSelect={() => props.onSelect(group.changeId)}
              onOpenDiff={() => props.onOpenDiff({ commitId: group.commitId })}
            />
            {expanded && (
              <ul className="ps-4">
                {group.files.map((file) => (
                  <JjFileRow
                    key={file.path}
                    file={file}
                    conflict={group.conflictPaths?.includes(file.path) === true}
                    canDiff={props.canDiff}
                    onOpenDiff={() =>
                      props.onOpenDiff({ commitId: group.commitId, filePath: file.path })
                    }
                    actions={
                      <JjFileActions
                        commitId={group.commitId}
                        path={file.path}
                        disabled={!props.canWrite}
                        squashParentId={squashParentId}
                        onRun={props.onRun}
                        onDialog={props.onDialog}
                      />
                    }
                  />
                ))}
                {group.files.length === 0 && (
                  <li className="flex h-6 items-center ps-1 text-muted-foreground">No changes</li>
                )}
                {group.filesTruncated && (
                  <li className="flex h-6 items-center ps-1 text-muted-foreground">
                    More files not shown. Open the diff to see all of them.
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
};
