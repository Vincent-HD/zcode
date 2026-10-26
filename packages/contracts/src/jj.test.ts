import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  JjDescribeInput,
  JjSquashInput,
  JjRevertOperationInput,
  JjRunActionInput,
  JjGetDiffInput,
  JjFilePath,
} from "./jj.ts";

const common = {
  cwd: "/repo",
  workspaceIdentity: {
    workspaceRoot: "/repo",
    repositoryPath: "/repo/.jj/repo",
    workspaceId: "workspace",
  },
  expectedOperationId: "a".repeat(128),
};
const describeInput = Schema.decodeUnknownSync(JjDescribeInput);
const squashInput = Schema.decodeUnknownSync(JjSquashInput);
const revertInput = Schema.decodeUnknownSync(JjRevertOperationInput);
const filePathInput = Schema.decodeUnknownSync(JjFilePath);

describe("jj mutation boundaries", () => {
  it.each(["@", "@-", "abc123", "all()", "a".repeat(39), "a".repeat(41)])(
    "rejects moving or non-full revision selector %s",
    (revisionCommitId) => {
      expect(() =>
        describeInput({ ...common, revisionCommitId, description: "message" }),
      ).toThrow();
      expect(() =>
        squashInput({
          ...common,
          sourceCommitId: "a".repeat(40),
          destinationCommitId: revisionCommitId,
        }),
      ).toThrow();
    },
  );
  it("rejects moving operation selectors for freshness and undo", () => {
    expect(() =>
      describeInput({
        ...common,
        expectedOperationId: "@",
        revisionCommitId: "a".repeat(40),
        description: "message",
      }),
    ).toThrow();
    expect(() => revertInput({ ...common, receiptId: "owned", operationId: "@" })).toThrow();
  });
});

describe("expanded jj boundaries", () => {
  const actionInput = Schema.decodeUnknownSync(JjRunActionInput);
  it.each([
    "",
    "/tmp/file",
    "../file",
    "dir/../file",
    "dir/./file",
    "dir//file",
    "dir/",
    ".jj/repo",
    "dir/.git/config",
    "C:/file",
    "file\\name",
    "file\0name",
  ])("rejects unsafe exact path %j", (path) => {
    expect(() => filePathInput(path)).toThrow();
    expect(() =>
      actionInput({
        ...common,
        action: { type: "restore", revisionCommitId: "a".repeat(40), paths: [path] },
      }),
    ).toThrow();
  });
  it.each(["all()", "glob:*.ts", 'odd\n"name.txt', "-file", "a | b"])(
    "allows literal file names %j",
    (path) => {
      expect(filePathInput(path)).toBe(path);
    },
  );
  it.each([
    { type: "new", parentCommitIds: [] },
    { type: "merge", parentCommitIds: ["a".repeat(40)] },
    { type: "abandon", revisionCommitIds: ["@"] },
    {
      type: "rebase",
      revisionCommitId: "a".repeat(40),
      destinationCommitIds: [],
      mode: "revision",
    },
    {
      type: "squash",
      sourceCommitId: "a".repeat(40),
      destinationCommitId: "b".repeat(40),
      mode: "into",
      paths: [],
    },
    { type: "restore", revisionCommitId: "a".repeat(40), paths: [] },
    { type: "push", bookmarkNames: [], remote: "origin" },
    { type: "push", bookmarkNames: ["glob:*"], remote: "origin" },
    { type: "push", bookmarkNames: ["main"], remote: "--all" },
  ])("rejects malformed action %j", (action) => {
    expect(() => actionInput({ ...common, action })).toThrow();
  });
  it("pins diff reads to full operation and commit IDs", () => {
    const diff = Schema.decodeUnknownSync(JjGetDiffInput);
    expect(diff({ ...common, revisionCommitId: "b".repeat(40), filePath: "a | b" }).filePath).toBe(
      "a | b",
    );
    expect(() =>
      diff({ ...common, expectedOperationId: "@", revisionCommitId: "b".repeat(40) }),
    ).toThrow();
    expect(() => diff({ ...common, revisionCommitId: "@" })).toThrow();
  });
});
