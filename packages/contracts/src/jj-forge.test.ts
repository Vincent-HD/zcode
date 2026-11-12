import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";
import {
  JjForgeBookmark,
  JjForgePreviewInput,
  buildJjForgeLayers,
  type JjForgeRevision,
} from "./jj-forge.ts";

const decodeRequest = Schema.decodeUnknownSync(JjForgePreviewInput);
const decodeBookmark = Schema.decodeUnknownSync(JjForgeBookmark);

const root = "0".repeat(40);
const first = "a".repeat(40);
const second = "b".repeat(40);
const third = "c".repeat(40);
const workspaceIdentity = {
  workspaceRoot: "/repo",
  repositoryPath: "/repo/.jj/repo",
  workspaceId: "workspace",
};
const revisions: ReadonlyArray<JjForgeRevision> = [
  {
    commitId: third,
    parentIds: [second],
    description: "third\n\nThird body",
    bookmarks: ["third", "other-third"],
    immutable: false,
    conflict: false,
  },
  {
    commitId: second,
    parentIds: [first],
    description: "second",
    bookmarks: ["second"],
    immutable: false,
    conflict: false,
  },
  {
    commitId: first,
    parentIds: [root],
    description: "first",
    bookmarks: ["first"],
    immutable: false,
    conflict: false,
  },
];
const request = decodeRequest({
  cwd: "/repo",
  workspaceIdentity,
  expectedOperationId: "d".repeat(128),
  projectId: ProjectId.make("project"),
  remote: "origin",
  mode: "linear-stack",
  baseBookmark: "main",
  selections: [
    { commitId: first, bookmark: "first" },
    { commitId: second, bookmark: "second" },
    { commitId: third, bookmark: "other-third" },
  ],
});

describe("JJ forge publication contracts", () => {
  it.each([SourceControlProviderKind.make("github"), SourceControlProviderKind.make("gitlab")])(
    "pairs every %s head with the explicit base or previous head",
    (provider) => {
      const layers = buildJjForgeLayers({ request, revisions, provider });
      expect(layers.map((layer) => [layer.bookmark, layer.baseBookmark])).toEqual([
        ["first", "main"],
        ["second", "first"],
        ["other-third", "second"],
      ]);
      expect(layers[2]).toMatchObject({ title: "third", body: "Third body" });
    },
  );
  it("publishes just the selected revision in single mode", () => {
    expect(
      buildJjForgeLayers({
        request: {
          ...request,
          mode: "single",
          selections: [{ commitId: third, bookmark: "third" }],
        },
        revisions,
        provider: SourceControlProviderKind.make("github"),
      }).map((layer) => [layer.bookmark, layer.baseBookmark]),
    ).toEqual([["third", "main"]]);
  });
  it.each(
    ["forgejo", "bitbucket", "azure-devops", "unknown"].map((provider) =>
      SourceControlProviderKind.make(provider),
    ),
  )("rejects unsupported %s publication", (provider) => {
    expect(() => buildJjForgeLayers({ request, revisions, provider })).toThrow("unsupported-forge");
  });
  it("rejects reversed, skipped, duplicate and singleton stacks", () => {
    for (const selections of [
      request.selections.toReversed(),
      [request.selections[0]!, request.selections[2]!],
      [request.selections[0]!, request.selections[0]!],
      [request.selections[0]!],
    ])
      expect(() =>
        buildJjForgeLayers({
          request: { ...request, selections },
          revisions,
          provider: SourceControlProviderKind.make("github"),
        }),
      ).toThrow();
  });
  it("rejects a merge at the bottom as well as in a later layer", () => {
    for (const commitId of [first, second]) {
      const merged = revisions.map((revision) =>
        revision.commitId === commitId ? { ...revision, parentIds: [root, third] } : revision,
      );
      expect(() =>
        buildJjForgeLayers({
          request,
          revisions: merged,
          provider: SourceControlProviderKind.make("github"),
        }),
      ).toThrow("nonlinear-stack");
    }
  });
  it("rejects a base/head collision and duplicate head bookmarks", () => {
    expect(() =>
      buildJjForgeLayers({
        request: { ...request, baseBookmark: "first" },
        revisions,
        provider: SourceControlProviderKind.make("github"),
      }),
    ).toThrow("duplicate-bookmark");
    expect(() =>
      buildJjForgeLayers({
        request: {
          ...request,
          selections: request.selections.map((selection) => ({ ...selection, bookmark: "first" })),
        },
        revisions,
        provider: SourceControlProviderKind.make("github"),
      }),
    ).toThrow("duplicate-bookmark");
  });
  it.each([
    { field: "immutable", value: true, reason: "immutable" },
    { field: "conflict", value: true, reason: "conflicted" },
    { field: "description", value: "\n ", reason: "missing-description" },
    { field: "bookmarks", value: [], reason: "missing-bookmark" },
  ])("rejects $reason before publication", ({ field, value, reason }) => {
    const changed = revisions.map((revision) =>
      revision.commitId === first ? { ...revision, [field]: value } : revision,
    );
    expect(() =>
      buildJjForgeLayers({
        request,
        revisions: changed,
        provider: SourceControlProviderKind.make("github"),
      }),
    ).toThrow(reason);
  });
  it.each([
    "--all",
    "a..b",
    "a//b",
    "a.lock",
    "a.lock/b",
    "a/",
    "a.",
    "a/.hidden",
    "a@origin",
    "a b",
    "a\nb",
    "heads(*)",
  ])("rejects unsafe bookmark %s", (bookmark) => {
    expect(() => decodeBookmark(bookmark)).toThrow();
  });
  it("rejects moving revision and operation selectors", () => {
    expect(() => decodeRequest({ ...request, expectedOperationId: "@" })).toThrow();
    expect(() =>
      decodeRequest({
        ...request,
        selections: [{ commitId: "@-", bookmark: "head" }],
      }),
    ).toThrow();
  });
});
