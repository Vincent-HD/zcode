import type { JjLogRow } from "@t3tools/contracts";

const JJ_GRAPH_COLORS = 8;

type GraphRow = Pick<JjLogRow, "commitId" | "parentIds" | "edges" | "edgesTruncated">;

export type JjGraphItem<R extends GraphRow> =
  | { readonly kind: "revision"; readonly key: string; readonly row: R }
  /** Stands in for the revisions a revset hides between a row and its listed ancestors. */
  | { readonly kind: "elided"; readonly key: string; readonly childCommitId: string };

export interface JjGraphLine {
  readonly lane: number;
  readonly color: number;
  readonly dashed: boolean;
}

export interface JjGraphCell {
  readonly lane: number;
  readonly color: number;
  /** Lines that pass this row without touching its node. */
  readonly through: ReadonlyArray<JjGraphLine>;
  /** Lines from the top of `lane` into this row's node. */
  readonly incoming: ReadonlyArray<JjGraphLine>;
  /** Lines from this row's node to the bottom of `lane`. */
  readonly outgoing: ReadonlyArray<JjGraphLine>;
}

export interface JjGraphLayout<R extends GraphRow> {
  readonly items: ReadonlyArray<JjGraphItem<R>>;
  readonly cells: ReadonlyArray<JjGraphCell>;
  readonly width: number;
}

interface Slot {
  readonly target: string;
  readonly color: number;
  readonly dashed: boolean;
}

const elidedKey = (commitId: string) => `~${commitId}`;

/**
 * Lanes top to bottom: each awaited parent holds a slot, the first parent keeps the child's lane
 * and freed lanes are reused; jj's topological order never lists a parent before its child.
 * Hidden ancestry routes through an "elided" row under the child, after jj-view (Apache-2.0).
 */
export const layoutJjGraph = <R extends GraphRow>(rows: ReadonlyArray<R>): JjGraphLayout<R> => {
  const items: Array<JjGraphItem<R>> = [];
  const parentsOf = new Map<string, ReadonlyArray<{ target: string; dashed: boolean }>>();
  for (const row of rows) {
    items.push({ kind: "revision", key: row.commitId, row });
    if (!row.edges) {
      parentsOf.set(
        row.commitId,
        row.parentIds.map((target) => ({ target, dashed: false })),
      );
      continue;
    }
    const elided = row.edges.filter((edge) => edge.elided);
    const direct = row.edges
      .filter((edge) => !edge.elided)
      .map((edge) => ({ target: edge.commitId, dashed: false }));
    if (!elided.length && !row.edgesTruncated) {
      parentsOf.set(row.commitId, direct);
      continue;
    }
    const key = elidedKey(row.commitId);
    parentsOf.set(row.commitId, [...direct, { target: key, dashed: false }]);
    parentsOf.set(
      key,
      elided.map((edge) => ({ target: edge.commitId, dashed: true })),
    );
    items.push({ kind: "elided", key, childCommitId: row.commitId });
  }

  const slots: Array<Slot | null> = [];
  const free = () => {
    const index = slots.indexOf(null);
    return index === -1 ? slots.length : index;
  };
  const cells: JjGraphCell[] = [];
  let width = 1;
  for (const item of items) {
    const arriving = slots.flatMap((slot, lane) => (slot?.target === item.key ? [lane] : []));
    const lane = arriving[0] ?? free();
    const color = slots[lane]?.color ?? lane % JJ_GRAPH_COLORS;
    const incoming = arriving.map((from) => ({
      lane: from,
      color: slots[from]!.color,
      dashed: slots[from]!.dashed,
    }));
    for (const from of arriving) slots[from] = null;
    const through = slots.flatMap((slot, index) =>
      slot ? [{ lane: index, color: slot.color, dashed: slot.dashed }] : [],
    );
    const outgoing: JjGraphLine[] = [];
    for (const [index, parent] of (parentsOf.get(item.key) ?? []).entries()) {
      const existing = slots.findIndex((slot) => slot?.target === parent.target);
      if (existing !== -1) {
        const slot = slots[existing]!;
        outgoing.push({ lane: existing, color: slot.color, dashed: parent.dashed });
        continue;
      }
      const target = index === 0 && slots[lane] == null ? lane : free();
      const slot = {
        target: parent.target,
        color: target === lane ? color : target % JJ_GRAPH_COLORS,
        dashed: parent.dashed,
      };
      slots[target] = slot;
      outgoing.push({ lane: target, color: slot.color, dashed: slot.dashed });
    }
    while (slots.length && slots.at(-1) === null) slots.pop();
    width = Math.max(
      width,
      lane + 1,
      slots.length,
      ...incoming.map((line) => line.lane + 1),
      ...through.map((line) => line.lane + 1),
    );
    cells.push({ lane, color, through, incoming, outgoing });
  }
  return { items, cells, width };
};
