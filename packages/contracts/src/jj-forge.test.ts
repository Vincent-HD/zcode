import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { JjPanelReady } from "./jj.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";
import { JjForgeBookmark, JjForgePreviewInput, buildJjForgeLayers } from "./jj-forge.ts";

const decodePanel = Schema.decodeUnknownSync(JjPanelReady);
const decodeRequest = Schema.decodeUnknownSync(JjForgePreviewInput);
const decodeBookmark = Schema.decodeUnknownSync(JjForgeBookmark);

const root = "0".repeat(40);
const first = "a".repeat(40);
const second = "b".repeat(40);
const third = "c".repeat(40);
const panel = decodePanel({
  status: "ready",
  cwd: "/repo",
  workspaceIdentity: {
    workspaceRoot: "/repo",
    repositoryPath: "/repo/.jj/repo",
    workspaceId: "workspace",
  },
  operationId: "d".repeat(128),
  workingCopyCommitId: third,
  filesTruncated: false,
  revisions: [
    {
      commitId: third,
      parentIds: [second],
      changeId: "k".repeat(32),
      description: "third\n\nThird body",
      bookmarks: ["third", "other-third"],
      immutable: false,
      conflict: false,
      empty: false,
      current: true,
      files: [],
    },
    {
      commitId: second,
      parentIds: [first],
      changeId: "l".repeat(32),
      description: "second",
      bookmarks: ["second"],
      immutable: false,
      conflict: false,
      empty: false,
      current: false,
      files: [],
    },
    {
      commitId: first,
      parentIds: [root],
      changeId: "m".repeat(32),
      description: "first",
      bookmarks: ["first"],
      immutable: false,
      conflict: false,
      empty: false,
      current: false,
      files: [],
    },
  ],
});
const request = decodeRequest({
  cwd: panel.cwd,
  workspaceIdentity: panel.workspaceIdentity,
  expectedOperationId: panel.operationId,
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
      const layers = buildJjForgeLayers({ request, panel, provider });
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
        panel,
        provider: SourceControlProviderKind.make("github"),
      }).map((layer) => [layer.bookmark, layer.baseBookmark]),
    ).toEqual([["third", "main"]]);
  });
  it.each(
    ["forgejo", "bitbucket", "azure-devops", "unknown"].map((provider) =>
      SourceControlProviderKind.make(provider),
    ),
  )("rejects unsupported %s publication", (provider) => {
    expect(() => buildJjForgeLayers({ request, panel, provider })).toThrow("unsupported-forge");
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
          panel,
          provider: SourceControlProviderKind.make("github"),
        }),
      ).toThrow();
  });
  it("rejects a merge at the bottom as well as in a later layer", () => {
    for (const commitId of [first, second]) {
      const merged = {
        ...panel,
        revisions: panel.revisions.map((revision) =>
          revision.commitId === commitId ? { ...revision, parentIds: [root, third] } : revision,
        ),
      };
      expect(() =>
        buildJjForgeLayers({
          request,
          panel: merged,
          provider: SourceControlProviderKind.make("github"),
        }),
      ).toThrow("nonlinear-stack");
    }
  });
  it("rejects a base/head collision and duplicate head bookmarks", () => {
    expect(() =>
      buildJjForgeLayers({
        request: { ...request, baseBookmark: "first" },
        panel,
        provider: SourceControlProviderKind.make("github"),
      }),
    ).toThrow("duplicate-bookmark");
    expect(() =>
      buildJjForgeLayers({
        request: {
          ...request,
          selections: request.selections.map((selection) => ({ ...selection, bookmark: "first" })),
        },
        panel,
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
    const changed = decodePanel({
      ...panel,
      revisions: panel.revisions.map((revision) =>
        revision.commitId === first ? { ...revision, [field]: value } : revision,
      ),
    });
    expect(() =>
      buildJjForgeLayers({
        request,
        panel: changed,
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
