import type { ContextMenuItem } from "@t3tools/contracts";

export type ZcodeThreadActionMenuId = "make-temporary" | "keep-permanent";

/** Temporary markers are local to this browser, so read-only clients may toggle them. */
export const ZCODE_THREAD_ACTIONS_WITHOUT_OPERATE = ["make-temporary", "keep-permanent"];

export const zcodeThreadActionMenuItems = (state: {
  readonly isTemporary?: boolean;
}): ReadonlyArray<ContextMenuItem<ZcodeThreadActionMenuId>> => [
  state.isTemporary
    ? { id: "keep-permanent", label: "Keep permanently", icon: "circle-check" }
    : { id: "make-temporary", label: "Make temporary", icon: "timer", separatorBefore: true },
];
