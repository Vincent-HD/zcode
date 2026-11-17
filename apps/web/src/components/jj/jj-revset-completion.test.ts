import type { JjLogRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyJjRevsetSuggestion, jjRevsetSuggestions } from "./jj-revset-completion";

const rows = [
  { bookmarks: ["main", "feat/x"], remoteBookmarks: ["main@origin"], tags: ["v1.0"] },
  { bookmarks: ["main", "weird name"] },
] as unknown as ReadonlyArray<JjLogRow>;
const aliases = [
  { name: "user(x)", definition: "author(x)" },
  { name: "wip", definition: "mine() & mutable()" },
];
const suggest = (text: string, caret = text.length, edited = true) =>
  jjRevsetSuggestions({ text, caret, edited, aliases, rows });
const accept = (text: string, label: string, caret = text.length) => {
  const suggestion = suggest(text, caret).find((candidate) => candidate.label === label);
  if (!suggestion) throw new Error(`no suggestion ${label} for ${text}`);
  return applyJjRevsetSuggestion({ text, caret, suggestion });
};

describe("jjRevsetSuggestions", () => {
  it("offers presets only while nothing is being typed", () => {
    expect(suggest("builtin_log()", 13, false)[0]?.kind).toBe("preset");
    expect(suggest("", 0)[0]?.kind).toBe("preset");
    expect(suggest("trunk() | ", 10)).toEqual([]);
  });

  it("matches the word before the caret, prefixes first, across names and aliases", () => {
    expect(suggest("::@ & mu").map((suggestion) => suggestion.label)).toEqual([
      "mutable()",
      "immutable_heads()",
      "immutable()",
    ]);
    const ma = suggest("ma").map((suggestion) => suggestion.label);
    expect(ma.slice(0, 2)).toEqual(["main", "main@origin"]);
    expect(ma).toContain("author_email(pattern)");
    expect(ma).not.toContain("reachable(srcs, domain)");
    expect(suggest("ma").filter((suggestion) => suggestion.label === "main")).toHaveLength(1);
    expect(suggest("us")[0]).toMatchObject({ kind: "alias", label: "user(x)" });
    expect(suggest("main").map((suggestion) => suggestion.label)).not.toContain("main");
  });
});

describe("applyJjRevsetSuggestion", () => {
  it("replaces only the typed word and leaves the caret inside a call that takes arguments", () => {
    expect(accept("trunk()..anc", "ancestors(x, [depth])")).toEqual({
      text: "trunk()..ancestors()",
      caret: 19,
    });
    expect(accept("muta & @", "mutable()", 4)).toEqual({ text: "mutable() & @", caret: 9 });
    expect(accept("us", "user(x)")).toEqual({ text: "user()", caret: 5 });
    expect(accept("w", "wip")).toEqual({ text: "wip", caret: 3 });
    const stale = suggest("us").find((suggestion) => suggestion.kind === "alias");
    expect(stale && applyJjRevsetSuggestion({ text: "us", caret: 13, suggestion: stale })).toEqual({
      text: "user()",
      caret: 5,
    });
  });

  it("quotes names that are not plain symbols and swaps presets in whole", () => {
    expect(accept("@ | wei", "weird name").text).toBe('@ | "weird name"');
    expect(accept("@ | feat", "feat/x").text).toBe("@ | feat/x");
    const preset = jjRevsetSuggestions({
      text: "all()",
      caret: 5,
      edited: false,
      aliases,
      rows,
    })[0];
    expect(
      preset && applyJjRevsetSuggestion({ text: "all()", caret: 5, suggestion: preset }),
    ).toEqual({
      text: "trunk()..@",
      caret: 10,
    });
  });
});
