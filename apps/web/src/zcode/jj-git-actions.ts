import type { JjLogRow } from "@t3tools/contracts";

/** The working copy's mutable stack down to trunk, which is all the actions look at. */
export const JJ_GIT_ACTIONS_VIEW = { revset: "trunk()..@ | trunk()", limit: 50 } as const;

// jj's default trunk() candidates. A remote bookmark in sync with its local one is not listed
// on the row, so these names are how trunk's own bookmark is told from the work's.
const TRUNK_NAMES = ["main", "master", "trunk"];

/** Where the remote copy of a bookmark points; rows omit it once it matches the local one. */
export const jjRemoteBookmarkView = (input: { bookmark: string; remote: string }) => ({
  revset: `remote_bookmarks(exact:"${input.bookmark}", exact:"${input.remote}")`,
  limit: 2,
});

export type JjGitAction = "commit" | "push" | "create-pr" | "view-pr" | "publish-stack";

/** One described revision of the work, bottom to top, with the bookmark that publishes it. */
export interface JjStackEntry {
  readonly row: JjLogRow;
  /** After the work's bookmark moves onto the target, as Push and publishing place it. */
  readonly bookmark: string | null;
}

export interface JjGitActionsState {
  readonly workingCopy: JjLogRow | null;
  /** The working copy has changes that Commit would describe and close. */
  readonly canCommit: boolean;
  readonly remote: string | null;
  /** Trunk's bookmark on the remote, which a pull request targets. */
  readonly baseBookmark: string | null;
  /** The newest described revision with changes: what Push and Create PR publish. */
  readonly target: JjLogRow | null;
  /** The work's own bookmark, wherever it sits between the target and trunk. */
  readonly bookmark: string | null;
  /** The commit the bookmark sits on now, which a pull request lookup matches. */
  readonly bookmarkCommitId: string | null;
  /** The bookmark sits below the target and has to move up before publishing. */
  readonly needsMove: boolean;
  /** The remote bookmark already points at the target. */
  readonly pushed: boolean;
  /** The described revisions from trunk up to the target. */
  readonly stack: ReadonlyArray<JjStackEntry>;
  /** The stack's bookmarks bottom to top; two or more make a stack of pull requests. */
  readonly stackBookmarks: ReadonlyArray<string>;
}

export const jjGitActionsState = (input: {
  readonly rows: ReadonlyArray<JjLogRow>;
  readonly workingCopyCommitId: string;
  readonly remotes: ReadonlyArray<string>;
  /** The commit the remote copy of the bookmark points at, when read. */
  readonly remoteHead?: { readonly bookmark: string; readonly commitId: string | null } | undefined;
}): JjGitActionsState => {
  const remote = input.remotes.includes("origin") ? "origin" : (input.remotes[0] ?? null);
  const onRemote = (row: JjLogRow, name: string) =>
    remote !== null && (row.remoteBookmarks ?? []).includes(`${name}@${remote}`);
  const workingCopy = input.rows.find((row) => row.commitId === input.workingCopyCommitId) ?? null;
  const mutable = input.rows.filter((row) => !row.immutable && !row.root);
  const trunk = input.rows.find((row) => row.immutable && !row.root) ?? null;
  const baseBookmark =
    trunk?.bookmarks?.find((name) => TRUNK_NAMES.includes(name)) ??
    trunk?.bookmarks?.find((name) => onRemote(trunk, name)) ??
    null;
  const target = mutable.find((row) => !row.empty && row.summary.trim() !== "") ?? null;
  // A worktree's bookmark starts on trunk beside trunk's own, which the remote already has.
  const ownBookmarks = (row: JjLogRow) =>
    (row.bookmarks ?? []).filter(
      (name) => !(row.immutable && (name === baseBookmark || onRemote(row, name))),
    );
  // The worktree's bookmark left on trunk claims the newest work before one placed on a lower
  // revision, so bookmarks set on a stack's lower layers stay where they were put.
  const bookmarkRow = [
    ...(target ? [target] : []),
    ...(trunk ? [trunk] : []),
    ...mutable.filter((row) => row !== target),
  ].find((row) => ownBookmarks(row).length > 0);
  const bookmark = bookmarkRow ? (ownBookmarks(bookmarkRow)[0] ?? null) : null;
  const needsMove = target !== null && bookmarkRow !== undefined && bookmarkRow !== target;
  const described = mutable.filter((row) => !row.empty && row.summary.trim() !== "");
  const stack = (target ? described.toReversed() : []).map((row): JjStackEntry => {
    if (row === target && bookmark !== null) return { row, bookmark };
    const own = ownBookmarks(row).filter((name) => !(needsMove && name === bookmark));
    return { row, bookmark: own[0] ?? null };
  });
  return {
    workingCopy,
    canCommit: workingCopy !== null && !workingCopy.empty && !workingCopy.immutable,
    remote,
    baseBookmark,
    target,
    bookmark,
    bookmarkCommitId: bookmarkRow?.commitId ?? null,
    needsMove,
    pushed:
      target !== null &&
      bookmark !== null &&
      !needsMove &&
      (onRemote(target, bookmark) ||
        (input.remoteHead?.bookmark === bookmark && input.remoteHead.commitId === target.commitId)),
    stack,
    stackBookmarks: stack.flatMap((entry) => (entry.bookmark ? [entry.bookmark] : [])),
  };
};

/** A free name for a new layer's bookmark, numbered after the work's own: `t3/x` gives `t3/x-2`. */
export const jjNextBookmarkName = (input: {
  readonly base: string;
  readonly taken: ReadonlyArray<string>;
}): string => {
  const stem = input.base.replace(/-\d+$/, "");
  let index = 2;
  while (input.taken.includes(`${stem}-${index}`)) index++;
  return `${stem}-${index}`;
};

/** Why an action cannot run now, or null when it can. */
export const jjGitActionBlocker = (
  state: JjGitActionsState,
  action: JjGitAction,
):
  | "clean"
  | "no-target"
  | "no-bookmark"
  | "no-remote"
  | "pushed"
  | "no-base"
  | "no-stack"
  | null => {
  if (action === "commit") return state.canCommit ? null : "clean";
  if (state.target === null) return "no-target";
  if (state.bookmark === null) return "no-bookmark";
  if (state.remote === null) return "no-remote";
  if (action === "push") return state.pushed ? "pushed" : null;
  if (action === "publish-stack") return state.stackBookmarks.length < 2 ? "no-stack" : null;
  return state.baseBookmark === null ? "no-base" : null;
};

/** The primary button: commit pending changes, push them, then open or view the pull request. */
export const jjQuickAction = (input: {
  readonly state: JjGitActionsState;
  readonly canCreatePullRequest: boolean;
  /** An open pull request already exists for the bookmark. */
  readonly hasPullRequest: boolean;
  /** Every layer of a stack already has an open pull request. */
  readonly stackPublished?: boolean | undefined;
}): JjGitAction | null => {
  if (jjGitActionBlocker(input.state, "commit") === null) return "commit";
  if (
    input.canCreatePullRequest &&
    input.stackPublished !== true &&
    jjGitActionBlocker(input.state, "publish-stack") === null &&
    jjGitActionBlocker(input.state, "push") !== "no-target"
  )
    return "publish-stack";
  if (jjGitActionBlocker(input.state, "push") === null) return "push";
  if (input.hasPullRequest) return "view-pr";
  if (input.canCreatePullRequest && jjGitActionBlocker(input.state, "create-pr") === null)
    return "create-pr";
  return null;
};
