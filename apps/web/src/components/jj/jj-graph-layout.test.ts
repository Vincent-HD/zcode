import { describe, expect, it } from "vite-plus/test";
import { layoutJjGraph } from "./jj-graph-layout";

const id = (letter: string) => letter.repeat(40);
const row = (
  letter: string,
  parents: ReadonlyArray<string>,
  extra: {
    edges?: ReadonlyArray<{ commitId: string; elided?: boolean }>;
    edgesTruncated?: boolean;
  } = {},
) => ({ commitId: id(letter), parentIds: parents.map(id), ...extra });
const lanes = (layout: ReturnType<typeof layoutJjGraph>) => layout.cells.map((cell) => cell.lane);

describe("Jujutsu graph lanes", () => {
  it("keeps a linear chain in one lane with continuous edges", () => {
    const layout = layoutJjGraph([row("a", ["b"]), row("b", ["c"]), row("c", [])]);
    expect(lanes(layout)).toEqual([0, 0, 0]);
    expect(layout.cells[0]).toMatchObject({ incoming: [], outgoing: [{ lane: 0 }], through: [] });
    expect(layout.cells[1]).toMatchObject({ incoming: [{ lane: 0 }], outgoing: [{ lane: 0 }] });
    expect(layout.cells[2]?.outgoing).toEqual([]);
    expect(layout.width).toBe(1);
  });

  it("forks siblings into a new lane that joins the shared parent", () => {
    const layout = layoutJjGraph([row("a", ["p"]), row("b", ["p"]), row("p", [])]);
    expect(lanes(layout)).toEqual([0, 1, 0]);
    expect(layout.cells[1]).toMatchObject({ through: [{ lane: 0 }], outgoing: [{ lane: 0 }] });
    expect(layout.cells[2]?.incoming).toEqual([{ lane: 0, color: 0, dashed: false }]);
    expect(layout.width).toBe(2);
  });

  it("opens a lane per merge parent and closes them where history converges", () => {
    const layout = layoutJjGraph([
      row("m", ["x", "y"]),
      row("x", ["r"]),
      row("y", ["r"]),
      row("r", []),
    ]);
    expect(lanes(layout)).toEqual([0, 0, 1, 0]);
    expect(layout.cells[0]?.outgoing.map((line) => line.lane)).toEqual([0, 1]);
    expect(layout.cells[1]?.through.map((line) => line.lane)).toEqual([1]);
    expect(layout.cells[2]?.outgoing.map((line) => line.lane)).toEqual([0]);
    expect(layout.cells[3]?.incoming.map((line) => line.lane)).toEqual([0]);
    expect(layout.cells[0]?.outgoing[1]?.color).not.toBe(layout.cells[0]?.outgoing[0]?.color);
  });

  it("reuses freed lanes and keeps unloaded parents open to the bottom", () => {
    const layout = layoutJjGraph([row("a", ["z"]), row("b", ["c"]), row("c", ["y"])]);
    expect(lanes(layout)).toEqual([0, 1, 1]);
    expect(layout.cells[2]?.through.map((line) => line.lane)).toEqual([0]);
    expect(layout.cells[2]?.outgoing.map((line) => line.lane)).toEqual([1]);
  });

  it("routes elided edges through a dashed ghost row and terminates truncated history", () => {
    const layout = layoutJjGraph([
      row("c", ["b"], { edges: [{ commitId: id("r"), elided: true }] }),
      row("d", ["e"], { edges: [], edgesTruncated: true }),
      row("r", []),
    ]);
    expect(layout.items.map((item) => item.kind)).toEqual([
      "revision",
      "elided",
      "revision",
      "elided",
      "revision",
    ]);
    expect(layout.cells[0]?.outgoing).toEqual([{ lane: 0, color: 0, dashed: false }]);
    expect(layout.cells[1]?.outgoing).toEqual([{ lane: 0, color: 0, dashed: true }]);
    expect(layout.cells[3]?.outgoing).toEqual([]);
    expect(layout.cells[4]?.incoming).toEqual([{ lane: 0, color: 0, dashed: true }]);
  });
});
