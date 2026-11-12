import { create } from "zustand";
import {
  JJ_NO_DRAG_KEYS,
  jjDragModifier,
  type JjDragKeys,
  type JjDragModifier,
  type JjDragSource,
} from "./jj-actions";

interface JjDragState {
  readonly source: JjDragSource | null;
  readonly targetCommitId: string | null;
  readonly keys: JjDragKeys;
  readonly pointer: { readonly x: number; readonly y: number };
}

const idle: JjDragState = {
  source: null,
  targetCommitId: null,
  keys: JJ_NO_DRAG_KEYS,
  pointer: { x: 0, y: 0 },
};

// Rows subscribe to one boolean each and only the hint follows the pointer, so moving a drag
// re-renders the hint and at most two rows instead of the graph.
export const useJjDragStore = create<JjDragState>(() => idle);

export const useJjDropTarget = (commitId: string) =>
  useJjDragStore((state) => state.source !== null && state.targetCommitId === commitId);

export const useJjDragging = (commitId: string) =>
  useJjDragStore(
    (state) => state.source?.kind === "revision" && state.source.commitId === commitId,
  );

const DRAG_THRESHOLD_PX = 5;

const keyOf = (event: KeyboardEvent): keyof JjDragKeys | null => {
  if (event.key === "Shift") return "shift";
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  return key === "r" || key === "s" || key === "d" || key === "m" ? key : null;
};

// One pointer drives at most one drag, so the click suppression flag is global UI state.
let suppressClick = false;

/** True once after a drag ends, so the row's trailing click does not also select it. */
export const consumeJjDragClick = () => {
  const value = suppressClick;
  suppressClick = false;
  return value;
};

/**
 * Tracks a pointer press as a potential drag. A press becomes a drag after a short movement;
 * R/S/Shift+S/D/M held during the drag choose the operation and Escape cancels it.
 */
export const beginJjDrag = (input: {
  event: { readonly button: number; readonly clientX: number; readonly clientY: number };
  source: JjDragSource;
  onDrop: (drop: {
    source: JjDragSource;
    targetCommitId: string;
    modifier: JjDragModifier;
  }) => void;
}) => {
  const { event, source } = input;
  if (event.button !== 0) return;
  const start = { x: event.clientX, y: event.clientY };
  let dragging = false;
  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("keyup", keyup, true);
    window.removeEventListener("blur", finish);
    useJjDragStore.setState(idle);
  };
  const move = (moveEvent: PointerEvent) => {
    const pointer = { x: moveEvent.clientX, y: moveEvent.clientY };
    if (!dragging) {
      if (Math.hypot(pointer.x - start.x, pointer.y - start.y) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      useJjDragStore.setState({ source, keys: { ...JJ_NO_DRAG_KEYS, shift: moveEvent.shiftKey } });
    }
    const target = document
      .elementFromPoint(pointer.x, pointer.y)
      ?.closest<HTMLElement>("[data-jj-drop]")?.dataset.jjDrop;
    useJjDragStore.setState({ pointer, targetCommitId: target ?? null });
  };
  const up = () => {
    const state = useJjDragStore.getState();
    if (dragging) {
      suppressClick = true;
      if (state.source && state.targetCommitId)
        input.onDrop({
          source: state.source,
          targetCommitId: state.targetCommitId,
          modifier: jjDragModifier(state.keys),
        });
    }
    finish();
  };
  const setKey = (event: KeyboardEvent, pressed: boolean) => {
    if (!dragging) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      suppressClick = true;
      finish();
      return;
    }
    const key = keyOf(event);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    const keys = useJjDragStore.getState().keys;
    if (keys[key] !== pressed) useJjDragStore.setState({ keys: { ...keys, [key]: pressed } });
  };
  const keydown = (event: KeyboardEvent) => setKey(event, true);
  const keyup = (event: KeyboardEvent) => setKey(event, false);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("blur", finish);
};
