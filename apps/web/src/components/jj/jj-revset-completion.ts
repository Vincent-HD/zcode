import { JJ_ORPHAN_REVSET, type JjLogRow, type JjRevsetAlias } from "@t3tools/contracts";

export interface JjRevsetSuggestion {
  readonly id: string;
  readonly kind: "preset" | "alias" | "function" | "bookmark" | "tag";
  readonly label: string;
  readonly detail: string;
  readonly insert: string;
}

const PRESETS: ReadonlyArray<readonly [revset: string, detail: string]> = [
  ["trunk()..@", "My stack: from trunk to the working copy"],
  ["mine() & mutable()", "My mutable revisions"],
  ["ancestors(@, 20)", "The working copy and its last 20 ancestors"],
  ["bookmarks() | @", "Bookmarked revisions and the working copy"],
  ["conflicts()", "Revisions with conflicts"],
  ["mutable() & empty() ~ @", "Empty mutable revisions to clean up"],
  ["divergent()", "Divergent changes"],
  ["all()", "Every visible revision"],
  [JJ_ORPHAN_REVSET, "Orphaned revisions: undescribed heads nothing keeps"],
];

// From `jj help -k revsets` (jj 0.46).
const FUNCTIONS: ReadonlyArray<readonly [signature: string, detail: string]> = [
  ["parents(x, [depth])", "Same as x-"],
  ["children(x, [depth])", "Same as x+"],
  ["ancestors(x, [depth])", "Same as ::x"],
  ["descendants(x, [depth])", "Same as x::"],
  ["first_parent(x, [depth])", "Like parents(), following first parents only"],
  ["first_ancestors(x, [depth])", "Like ancestors(), following first parents only"],
  ["reachable(srcs, domain)", "Commits reachable from srcs within domain"],
  ["connected(x)", "Same as x::x"],
  ["all()", "All visible commits"],
  ["none()", "No commits"],
  ["change_id(prefix)", "Commits with this change ID prefix"],
  ["commit_id(prefix)", "Commits with this commit ID prefix"],
  ["bookmarks([pattern])", "Local bookmark targets"],
  ["remote_bookmarks([name], [remote])", "Remote bookmark targets"],
  ["tracked_remote_bookmarks([name], [remote])", "Tracked remote bookmark targets"],
  ["untracked_remote_bookmarks([name], [remote])", "Untracked remote bookmark targets"],
  ["tags([pattern])", "Tag targets"],
  ["remote_tags([name], [remote])", "Remote tag targets"],
  ["visible_heads()", "All visible heads"],
  ["root()", "The virtual root commit"],
  ["heads(x)", "Commits in x that are not ancestors of others in x"],
  ["roots(x)", "Commits in x that are not descendants of others in x"],
  ["latest(x, [count])", "Latest commits in x by committer date"],
  ["fork_point(x)", "The fork point of all commits in x"],
  ["merge_point(x)", "The merge point of all commits in x"],
  ["bisect(x)", "Commits splitting x in about half"],
  ["exactly(x, count)", "x, failing unless it has exactly count commits"],
  ["merges()", "Merge commits"],
  ["forks()", "Commits with more than one child"],
  ["description(pattern)", "Description matches pattern"],
  ["subject(pattern)", "First description line matches pattern"],
  ["author(pattern)", "Author name or email matches pattern"],
  ["author_name(pattern)", "Author name matches pattern"],
  ["author_email(pattern)", "Author email matches pattern"],
  ["author_date(pattern)", 'Author date matches, e.g. after:"1 week ago"'],
  ["mine()", "Authored with your email"],
  ["committer(pattern)", "Committer name or email matches pattern"],
  ["committer_name(pattern)", "Committer name matches pattern"],
  ["committer_email(pattern)", "Committer email matches pattern"],
  ["committer_date(pattern)", "Committer date matches pattern"],
  ["signed()", "Cryptographically signed commits"],
  ["empty()", "Commits modifying no files"],
  ["files(expression)", "Commits modifying paths matching a fileset"],
  ["diff_lines(text, [files])", "Diff lines match text"],
  ["diff_lines_added(text, [files])", "Added lines match text"],
  ["diff_lines_removed(text, [files])", "Removed lines match text"],
  ["conflicts()", "Commits with conflicted files"],
  ["divergent()", "Divergent changes"],
  ["present(x)", "x, or none() if any of it is missing"],
  ["coalesce(revsets...)", "The first non-empty revset"],
  ["working_copies()", "Working copies of all workspaces"],
  ["at_operation(op, x)", "x evaluated at an operation"],
  ["trunk()", "Head of the default remote's default bookmark"],
  ["builtin_log()", "jj's default log revset"],
  ["immutable_heads()", "Heads of the immutable commits"],
  ["immutable()", "Commits jj treats as immutable"],
  ["mutable()", "Commits jj treats as mutable"],
  ["visible()", "Same as ::visible_heads()"],
  ["hidden()", "Hidden commits"],
];

const MAX_SUGGESTIONS = 40;
const TOKEN = /[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const PLAIN_SYMBOL = /^[A-Za-z0-9_](?:[A-Za-z0-9_./@-]*[A-Za-z0-9_])?$/;

/** `name(x, y)` inserts `name()` with the caret inside; `name()` and `name` insert as they are. */
const callable = (signature: string) => {
  const open = signature.indexOf("(");
  if (open < 0) return { name: signature, insert: signature, takesArgs: false };
  const name = signature.slice(0, open);
  return { name, insert: `${name}()`, takesArgs: signature.slice(open + 1, -1).trim() !== "" };
};

const symbol = (name: string) => (PLAIN_SYMBOL.test(name) ? name : JSON.stringify(name));

const FUNCTION_SUGGESTIONS: ReadonlyArray<JjRevsetSuggestion> = FUNCTIONS.map(
  ([signature, detail]) => ({
    id: `function:${signature}`,
    kind: "function",
    label: signature,
    detail,
    insert: callable(signature).insert,
  }),
);

const PRESET_SUGGESTIONS: ReadonlyArray<JjRevsetSuggestion> = PRESETS.map(([revset, detail]) => ({
  id: `preset:${revset}`,
  kind: "preset",
  label: revset,
  detail,
  insert: revset,
}));

/** The word being typed before the caret, which a suggestion replaces. */
const tokenAt = (text: string, caret: number) => {
  const end = Math.min(caret, text.length);
  const token = TOKEN.exec(text.slice(0, end))?.[0] ?? "";
  return { token, start: end - token.length, end };
};

/**
 * Suggestions for the revset input: presets that replace the whole revset when nothing is typed,
 * otherwise aliases, functions, bookmarks and tags matching the word before the caret.
 */
export const jjRevsetSuggestions = (input: {
  text: string;
  caret: number;
  /** False while the input still shows the applied revset, so presets can replace it. */
  edited: boolean;
  aliases: ReadonlyArray<JjRevsetAlias>;
  rows: ReadonlyArray<JjLogRow>;
}): ReadonlyArray<JjRevsetSuggestion> => {
  const { token } = tokenAt(input.text, input.caret);
  if (!token) return !input.edited || !input.text.trim() ? PRESET_SUGGESTIONS : [];
  const names = (kind: "bookmark" | "tag", values: Iterable<string>) =>
    [...new Set(values)].map((name): JjRevsetSuggestion => ({
      id: `${kind}:${name}`,
      kind,
      label: name,
      detail: kind,
      insert: symbol(name),
    }));
  const candidates = [
    ...input.aliases.map((alias): JjRevsetSuggestion => ({
      id: `alias:${alias.name}`,
      kind: "alias",
      label: alias.name,
      detail: alias.definition,
      insert: callable(alias.name).insert,
    })),
    ...FUNCTION_SUGGESTIONS,
    ...names(
      "bookmark",
      input.rows.flatMap((row) => [...(row.bookmarks ?? []), ...(row.remoteBookmarks ?? [])]),
    ),
    ...names(
      "tag",
      input.rows.flatMap((row) => row.tags ?? []),
    ),
  ];
  const needle = token.toLowerCase();
  const nameOf = (suggestion: JjRevsetSuggestion) => callable(suggestion.label).name.toLowerCase();
  const matches = (suggestion: JjRevsetSuggestion) =>
    nameOf(suggestion).startsWith(needle) ? 0 : 1;
  return candidates
    .filter((suggestion) => nameOf(suggestion).includes(needle) && suggestion.insert !== token)
    .toSorted((left, right) => matches(left) - matches(right))
    .slice(0, MAX_SUGGESTIONS);
};

/** The text and caret after accepting a suggestion. */
export const applyJjRevsetSuggestion = (input: {
  text: string;
  caret: number;
  suggestion: JjRevsetSuggestion;
}) => {
  const { suggestion } = input;
  if (suggestion.kind === "preset")
    return { text: suggestion.insert, caret: suggestion.insert.length };
  const { start, end } = tokenAt(input.text, input.caret);
  const before = input.text.slice(0, start) + suggestion.insert;
  const takesArgs =
    suggestion.kind !== "bookmark" &&
    suggestion.kind !== "tag" &&
    callable(suggestion.label).takesArgs;
  return {
    text: before + input.text.slice(end),
    caret: takesArgs ? before.length - 1 : before.length,
  };
};
