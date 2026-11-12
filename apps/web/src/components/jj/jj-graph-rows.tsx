import type { JjLogRow } from "@t3tools/contracts";
import { Bookmark, Laptop, Tag } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import { JJ_DRAG_LABELS, jjDragModifier, jjDropAction, type JjDragSource } from "./jj-actions";
import { useJjDragStore, useJjDragging, useJjDropTarget } from "./jj-drag";
import type { JjGraphCell, JjGraphLine } from "./jj-graph-layout";

export const JJ_ROW_HEIGHT = 40;
export const JJ_ELIDED_ROW_HEIGHT = 20;
const LANE_WIDTH = 14;
const NODE_Y = 12;

// Literal class names keep Tailwind's scanner aware of every lane color.
const STROKES = [
  "stroke-sky-500",
  "stroke-violet-500",
  "stroke-amber-500",
  "stroke-emerald-500",
  "stroke-rose-500",
  "stroke-cyan-500",
  "stroke-orange-500",
  "stroke-fuchsia-500",
];
const FILLS = [
  "fill-sky-500",
  "fill-violet-500",
  "fill-amber-500",
  "fill-emerald-500",
  "fill-rose-500",
  "fill-cyan-500",
  "fill-orange-500",
  "fill-fuchsia-500",
];

const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2 + 2;
const curve = (input: { fromLane: number; fromY: number; toLane: number; toY: number }) => {
  const x1 = laneX(input.fromLane);
  const x2 = laneX(input.toLane);
  if (x1 === x2) return `M${x1} ${input.fromY}V${input.toY}`;
  const mid = (input.fromY + input.toY) / 2;
  return `M${x1} ${input.fromY}C${x1} ${mid} ${x2} ${mid} ${x2} ${input.toY}`;
};

const Line = (props: { line: JjGraphLine; d: string }) => (
  <path
    d={props.d}
    className={STROKES[props.line.color]}
    strokeWidth={1.5}
    fill="none"
    strokeDasharray={props.line.dashed ? "2 3" : undefined}
  />
);

type NodeKind =
  | "working-copy"
  | "immutable"
  | "conflict"
  | "empty"
  | "hidden"
  | "mutable"
  | "elided";

const jjNodeKind = (row: JjLogRow): NodeKind =>
  row.current
    ? "working-copy"
    : row.conflict
      ? "conflict"
      : row.hidden
        ? "hidden"
        : row.immutable || row.root
          ? "immutable"
          : row.empty
            ? "empty"
            : "mutable";

const Node = (props: { kind: NodeKind; color: number; x: number; y: number }) => {
  const { x, y } = props;
  const stroke = STROKES[props.color];
  const fill = FILLS[props.color];
  switch (props.kind) {
    case "working-copy":
      return (
        <>
          <circle cx={x} cy={y} r={5} className={cn(stroke, "fill-background")} strokeWidth={2} />
          <circle cx={x} cy={y} r={2} className={fill} />
        </>
      );
    case "immutable":
      return (
        <path d={`M${x} ${y - 5}L${x + 5} ${y}L${x} ${y + 5}L${x - 5} ${y}Z`} className={fill} />
      );
    case "conflict":
      return (
        <path
          d={`M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}`}
          className="stroke-destructive"
          strokeWidth={2.5}
        />
      );
    case "empty":
      return (
        <circle cx={x} cy={y} r={4} className={cn(stroke, "fill-background")} strokeWidth={1.5} />
      );
    case "hidden":
      return (
        <circle
          cx={x}
          cy={y}
          r={4}
          className={cn(stroke, "fill-background opacity-60")}
          strokeWidth={1.5}
          strokeDasharray="2 2"
        />
      );
    case "elided":
      return (
        <circle
          cx={x}
          cy={y}
          r={2.5}
          className="fill-background stroke-muted-foreground"
          strokeWidth={1.25}
        />
      );
    case "mutable":
      return <circle cx={x} cy={y} r={4} className={fill} />;
  }
};

const JjGraphCellSvg = (props: {
  cell: JjGraphCell;
  width: number;
  height: number;
  nodeY: number;
  kind: NodeKind;
}) => {
  const { cell, height, nodeY } = props;
  return (
    <svg
      aria-hidden="true"
      width={props.width * LANE_WIDTH + 4}
      height={height}
      className="shrink-0 overflow-visible"
    >
      {cell.through.map((line) => (
        <Line
          key={`t${line.lane}`}
          line={line}
          d={curve({ fromLane: line.lane, fromY: 0, toLane: line.lane, toY: height })}
        />
      ))}
      {cell.incoming.map((line) => (
        <Line
          key={`i${line.lane}`}
          line={line}
          d={curve({ fromLane: line.lane, fromY: 0, toLane: cell.lane, toY: nodeY })}
        />
      ))}
      {cell.outgoing.map((line) => (
        <Line
          key={`o${line.lane}`}
          line={line}
          d={curve({ fromLane: cell.lane, fromY: nodeY, toLane: line.lane, toY: height })}
        />
      ))}
      <Node kind={props.kind} color={cell.color} x={laneX(cell.lane)} y={nodeY} />
    </svg>
  );
};

export const JjRelativeTime = (props: { timestamp: string }) => {
  const state = useRelativeTimeState(props.timestamp);
  if (state.status !== "relative") return null;
  return (
    <time dateTime={props.timestamp}>
      {state.suffix ? `${state.value} ${state.suffix}` : state.value}
    </time>
  );
};

export const JjHint = (props: { label: ReactNode; render: ReactElement; children: ReactNode }) => (
  <Tooltip>
    <TooltipTrigger render={props.render}>{props.children}</TooltipTrigger>
    <TooltipPopup>{props.label}</TooltipPopup>
  </Tooltip>
);

export const JjChangeId = (props: { row: JjLogRow; length?: number }) => {
  const length = Math.max(props.length ?? 8, props.row.changePrefixLength);
  const prefix = props.row.changeId.slice(0, props.row.changePrefixLength);
  const rest = props.row.changeId.slice(props.row.changePrefixLength, length);
  return (
    <span className={cn("shrink-0 font-mono", props.row.hidden && "italic")}>
      <span className={props.row.divergent ? "text-warning-foreground" : "text-info-foreground"}>
        {prefix}
      </span>
      <span className="text-muted-foreground">{rest}</span>
      {props.row.changeOffset !== undefined && (
        <span className="text-warning-foreground">/{props.row.changeOffset}</span>
      )}
    </span>
  );
};

const Pill = (props: {
  variant: "info" | "secondary" | "success" | "warning";
  icon: ReactNode;
  label: string;
  tooltip: string;
  onPointerDown?: (event: React.PointerEvent) => void;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <span
          className={cn("inline-flex min-w-0 max-w-32", props.onPointerDown && "cursor-grab")}
          onPointerDown={props.onPointerDown}
        />
      }
    >
      <Badge size="sm" variant={props.variant}>
        {props.icon}
        <span className="truncate">{props.label}</span>
      </Badge>
    </TooltipTrigger>
    <TooltipPopup>{props.tooltip}</TooltipPopup>
  </Tooltip>
);

export const JjRefPills = (props: {
  row: JjLogRow;
  onBookmarkPointerDown?: (event: React.PointerEvent, source: JjDragSource) => void;
}) => (
  <>
    {props.row.workingCopies?.map((name) => (
      <Pill
        key={`w:${name}`}
        variant="warning"
        icon={<Laptop />}
        label={`${name}@`}
        tooltip={`Working copy of workspace ${name}`}
      />
    ))}
    {props.row.bookmarks?.map((name) => (
      <Pill
        key={`b:${name}`}
        variant="info"
        icon={<Bookmark />}
        label={name}
        tooltip={props.onBookmarkPointerDown ? `${name} · drag to move` : name}
        {...(props.onBookmarkPointerDown
          ? {
              onPointerDown: (event: React.PointerEvent) => {
                event.stopPropagation();
                props.onBookmarkPointerDown?.(event, {
                  kind: "bookmark",
                  name,
                  commitId: props.row.commitId,
                });
              },
            }
          : {})}
      />
    ))}
    {props.row.remoteBookmarks?.map((name) => (
      <Pill
        key={`r:${name}`}
        variant="secondary"
        icon={<Bookmark />}
        label={name}
        tooltip={`Remote bookmark ${name}`}
      />
    ))}
    {props.row.tags?.map((name) => (
      <Pill
        key={`t:${name}`}
        variant="success"
        icon={<Tag />}
        label={name}
        tooltip={`Tag ${name}`}
      />
    ))}
  </>
);

export const JjRevisionRow = (props: {
  id: string;
  row: JjLogRow;
  cell: JjGraphCell;
  width: number;
  top: number;
  selected: boolean;
  active: boolean;
  onPointerDown?: (event: React.PointerEvent, source: JjDragSource) => void;
  onClick: (event: React.MouseEvent, row: JjLogRow) => void;
  onContextMenu: (event: React.MouseEvent, row: JjLogRow) => void;
}) => {
  const { row } = props;
  const dropTarget = useJjDropTarget(row.commitId);
  const dragging = useJjDragging(row.commitId);
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      data-jj-drop={row.commitId}
      className={cn(
        "absolute inset-x-0 flex cursor-default select-none items-start gap-1 pe-2 text-xs",
        props.selected ? "bg-accent" : "hover:bg-accent/50",
        props.active && "outline-1 -outline-offset-1 outline-ring",
        dropTarget && "bg-info/15 outline-1 -outline-offset-1 outline-info",
        dragging && "opacity-50",
        row.hidden && "text-muted-foreground",
      )}
      style={{ top: props.top, height: JJ_ROW_HEIGHT }}
      onPointerDown={
        props.onPointerDown
          ? (event) => props.onPointerDown?.(event, { kind: "revision", commitId: row.commitId })
          : undefined
      }
      onClick={(event) => props.onClick(event, row)}
      onContextMenu={(event) => props.onContextMenu(event, row)}
    >
      <JjGraphCellSvg
        cell={props.cell}
        width={props.width}
        height={JJ_ROW_HEIGHT}
        nodeY={NODE_Y}
        kind={jjNodeKind(row)}
      />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          <JjChangeId row={row} />
          <span className={cn("truncate", !row.summary && "text-muted-foreground italic")}>
            {row.summary || (row.root ? "root()" : "(no description)")}
          </span>
          {row.empty && !row.root && (
            <span className="shrink-0 text-2xs text-muted-foreground">empty</span>
          )}
          {row.conflict && <span className="shrink-0 text-2xs text-destructive">conflict</span>}
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1 overflow-hidden text-2xs text-muted-foreground">
          <JjRefPills
            row={row}
            {...(props.onPointerDown ? { onBookmarkPointerDown: props.onPointerDown } : {})}
          />
          {!row.root && (
            <JjHint
              label={`${row.author.name} <${row.author.email}> · ${row.author.timestamp}`}
              render={<span className="ms-auto shrink-0 truncate ps-1" />}
            >
              {row.author.name || row.author.email} ·{" "}
              <JjRelativeTime timestamp={row.author.timestamp} />
            </JjHint>
          )}
        </div>
      </div>
    </div>
  );
};

export const JjElidedRow = (props: { cell: JjGraphCell; width: number; top: number }) => (
  <div
    aria-hidden="true"
    className="absolute inset-x-0 flex items-center gap-1 text-2xs text-muted-foreground italic"
    style={{ top: props.top, height: JJ_ELIDED_ROW_HEIGHT }}
  >
    <JjGraphCellSvg
      cell={props.cell}
      width={props.width}
      height={JJ_ELIDED_ROW_HEIGHT}
      nodeY={JJ_ELIDED_ROW_HEIGHT / 2}
      kind="elided"
    />
    {props.cell.outgoing.length ? "elided revisions" : "history continues outside the revset"}
  </div>
);

/** Follows the pointer during a drag; the only component subscribed to pointer movement. */
export const JjDragHint = (props: { rows: ReadonlyArray<JjLogRow> }) => {
  const state = useJjDragStore();
  if (!state.source) return null;
  const modifier = jjDragModifier(state.keys);
  const result = state.targetCommitId
    ? jjDropAction({
        source: state.source,
        targetCommitId: state.targetCommitId,
        modifier,
        rows: props.rows,
      })
    : null;
  const label =
    state.source.kind === "bookmark"
      ? result?.ok
        ? result.label
        : `Move ${state.source.name}`
      : result?.ok
        ? result.label
        : JJ_DRAG_LABELS[modifier];
  return (
    <div
      role="status"
      className="pointer-events-none fixed z-[140] max-w-72 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
      style={{ left: state.pointer.x + 14, top: state.pointer.y + 14 }}
    >
      <div className={cn("font-medium", result && !result.ok && "text-destructive")}>
        {result && !result.ok ? result.reason : label}
      </div>
      {state.source.kind === "revision" && (
        <div className="text-2xs text-muted-foreground">
          Hold R revision only · S squash · ⇧S squash onto · D duplicate · M merge · Esc cancel
        </div>
      )}
    </div>
  );
};
