import * as Crypto from "effect/Crypto";
import {
  JjPanelError,
  JjCommitId,
  JjChangeId,
  JjOperationId,
  JjChangedFile,
  JjSignature,
  JjFilePath,
  JjBookmarkName,
  JjRunActionInput,
  JjGetDiffInput,
  type JjDiffResult,
  type JjWorkspaceIdentity,
  type JjPanelReady,
  type JjPanelSnapshot,
  type JjRevision,
  type JjGetPanelInput,
  type JjDescribeInput,
  type JjSquashInput,
  type JjRevertOperationInput,
  type JjMutationResult,
  type JjActionReceipt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const Commit = Schema.Struct({
  commit_id: JjCommitId,
  change_id: JjChangeId,
  parents: Schema.Array(JjCommitId),
  description: Schema.String,
  author: JjSignature,
  committer: JjSignature,
});
const RevisionOutput = Schema.Struct({
  commit: Commit,
  immutable: Schema.Boolean,
  conflict: Schema.Boolean,
  empty: Schema.Boolean,
  current: Schema.Boolean,
  files: Schema.Array(JjChangedFile),
  filesTruncated: Schema.Boolean,
  bookmarks: Schema.Array(
    Schema.Struct({ name: Schema.String, remote: Schema.NullOr(Schema.String) }),
  ),
  tags: Schema.Array(Schema.String),
  conflictPaths: Schema.Array(Schema.String),
});
const Operation = Schema.Struct({
  id: JjOperationId,
  parents: Schema.Array(JjOperationId),
  username: Schema.String,
});
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const jsonObjectTemplate = (fields: Readonly<Record<string, string>>) =>
  `${quote("{")} ++ ${Object.entries(fields)
    .map(([key, value]) => `${quote(`${quote(key)}:`)} ++ ${value}`)
    .join(` ++ ${quote(",")} ++ `)} ++ ${quote("}")}`;
const fileTemplate = jsonObjectTemplate({ path: "json(f.path())", status: "json(f.status())" });
// jj's `bookmarks` keyword lists a remote bookmark only where it differs from the local one.
const bookmarkTemplate = jsonObjectTemplate({
  name: "json(b.name())",
  remote: `if(b.remote(), json(b.remote()), ${quote("null")})`,
});
const revisionTemplate = jsonObjectTemplate({
  commit: "json(self)",
  immutable: "json(immutable)",
  conflict: "json(conflict)",
  empty: "json(empty)",
  current: "json(current_working_copy)",
  files: `${quote("[")} ++ diff.files().take(256).map(|f| ${fileTemplate}).join(",") ++ ${quote("]")}`,
  filesTruncated: "json(diff.files().len() > 256)",
  bookmarks: `${quote("[")} ++ bookmarks.take(64).map(|b| ${bookmarkTemplate}).join(",") ++ ${quote("]")}`,
  tags: "json(tags.take(64).map(|t| t.name()))",
  conflictPaths: "json(conflicted_files.take(256).map(|f| f.path()))",
});
const revisionsTemplate = `${revisionTemplate} ++ "\\n"`;
const error = (reason: JjPanelError["reason"]) => new JjPanelError({ reason });
const decodeFilePath = Schema.decodeUnknownEffect(JjFilePath);
const isJjBookmarkName = Schema.is(JjBookmarkName);
const decodeRunAction = Schema.decodeUnknownEffect(JjRunActionInput);
const decodeGetDiff = Schema.decodeUnknownEffect(JjGetDiffInput);

export class JjPanelService extends Context.Service<
  JjPanelService,
  {
    readonly getPanel: (input: JjGetPanelInput) => Effect.Effect<JjPanelSnapshot, JjPanelError>;
    readonly runAction: (input: JjRunActionInput) => Effect.Effect<JjMutationResult, JjPanelError>;
    readonly getDiff: (input: JjGetDiffInput) => Effect.Effect<JjDiffResult, JjPanelError>;
    readonly describe: (input: JjDescribeInput) => Effect.Effect<JjMutationResult, JjPanelError>;
    readonly squash: (input: JjSquashInput) => Effect.Effect<JjMutationResult, JjPanelError>;
    readonly revertOperation: (
      input: JjRevertOperationInput,
    ) => Effect.Effect<JjMutationResult, JjPanelError>;
  }
>()("t3/jj/JjPanelService") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  // Repository-scoped resource locks never expire while queued users still hold them.
  const locks = new Map<string, Semaphore.Semaphore>();
  const receipts = new Map<string, { identity: JjWorkspaceIdentity; receipt: JjActionReceipt }>();
  const run = Effect.fn("JjPanelService.run")(function* (input: {
    cwd: string;
    args: ReadonlyArray<string>;
    stdin?: string;
  }) {
    return yield* process.run({
      operation: "JjPanelService.cli",
      command: "jj",
      cwd: input.cwd,
      args: ["--no-pager", "--color=never", ...input.args],
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      outputMode: "error",
      maxOutputBytes: 4_000_000,
    });
  });
  const decode = <S extends Schema.Top>(schema: S, value: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError(() => error("invalid-output")),
    );
  const cli = Effect.fn("JjPanelService.cli")(function* (input: {
    cwd: string;
    args: ReadonlyArray<string>;
    stdin?: string;
  }) {
    const output = yield* run(input).pipe(Effect.mapError(() => error("command-failed")));
    if (output.stdoutInvalidUtf8 || output.stdoutTruncated) return yield* error("invalid-output");
    return output.stdout;
  });
  const resolve = Effect.fn("JjPanelService.resolve")(function* (
    input: JjGetPanelInput,
  ): Effect.fn.Return<
    JjWorkspaceIdentity | Extract<JjPanelSnapshot, { status: "unavailable" }>,
    JjPanelError
  > {
    const version = yield* run({ cwd: input.cwd, args: ["--version"] }).pipe(
      Effect.map(() => true),
      Effect.catchTags({ VcsProcessSpawnError: () => Effect.succeed(false) }),
      Effect.mapError(() => error("command-failed")),
    );
    if (!version)
      return {
        status: "unavailable",
        cwd: input.cwd,
        reason: "missing-executable",
      } satisfies JjPanelSnapshot;
    let directory = yield* fs
      .realPath(input.cwd)
      .pipe(Effect.mapError(() => error("command-failed")));
    while (
      !(yield* fs
        .exists(path.join(directory, ".jj"))
        .pipe(Effect.mapError(() => error("command-failed"))))
    ) {
      const parent = path.dirname(directory);
      if (parent === directory)
        return {
          status: "unavailable",
          cwd: input.cwd,
          reason: "not-jj-workspace",
        } satisfies JjPanelSnapshot;
      directory = parent;
    }
    const root = (yield* cli({
      cwd: input.cwd,
      args: ["--ignore-working-copy", "workspace", "root"],
    })).trim();
    const workspaceRoot = yield* fs
      .realPath(root)
      .pipe(Effect.mapError(() => error("command-failed")));
    const repoEntry = path.join(workspaceRoot, ".jj", "repo");
    const repoInfo = yield* fs.stat(repoEntry).pipe(Effect.mapError(() => error("command-failed")));
    const repoLocation =
      repoInfo.type === "File"
        ? path.resolve(
            path.dirname(repoEntry),
            (yield* fs
              .readFileString(repoEntry)
              .pipe(Effect.mapError(() => error("command-failed")))).trim(),
          )
        : repoEntry;
    const repositoryPath = yield* fs
      .realPath(repoLocation)
      .pipe(Effect.mapError(() => error("command-failed")));
    const wcInfo = yield* fs
      .stat(path.join(workspaceRoot, ".jj", "working_copy"))
      .pipe(Effect.mapError(() => error("command-failed")));
    return {
      workspaceRoot,
      repositoryPath,
      workspaceId: `${workspaceRoot}:${wcInfo.dev}:${Option.getOrElse(wcInfo.ino, () => 0)}`,
    } satisfies JjWorkspaceIdentity;
  });
  const lockFor = (identity: JjWorkspaceIdentity) => {
    const existing = locks.get(identity.repositoryPath);
    if (existing) return existing;
    const lock = Semaphore.makeUnsafe(1);
    locks.set(identity.repositoryPath, lock);
    return lock;
  };
  const head = Effect.fn("JjPanelService.head")(function* (cwd: string) {
    return yield* decode(
      Operation,
      yield* cli({
        cwd,
        args: [
          "--ignore-working-copy",
          "--at-operation",
          "@",
          "op",
          "log",
          "--no-graph",
          "--limit",
          "1",
          "-T",
          "json(self)",
        ],
      }),
    );
  });
  const readPinned = Effect.fn("JjPanelService.readPinned")(function* (input: {
    cwd: string;
    identity: JjWorkspaceIdentity;
    operationId: string;
  }) {
    const pinned = ["--at-operation", input.operationId];
    const wc = yield* decode(
      JjCommitId,
      yield* cli({
        cwd: input.cwd,
        args: [...pinned, "log", "--no-graph", "-r", "@", "-T", "json(commit_id)"],
      }),
    );
    const lines = yield* cli({
      cwd: input.cwd,
      args: [
        ...pinned,
        "log",
        "--no-graph",
        "--limit",
        "11",
        "-r",
        `ancestors(${wc})`,
        "-T",
        revisionsTemplate,
      ],
    });
    const parse = (output: string) =>
      Effect.forEach(output.trim().split("\n").filter(Boolean), (line) =>
        decode(RevisionOutput, line),
      );
    const decoded = yield* parse(lines);
    const extraLines = yield* cli({
      cwd: input.cwd,
      args: [
        ...pinned,
        "log",
        "--no-graph",
        "--limit",
        "65",
        "-r",
        `mutable() ~ (${decoded.map((revision) => revision.commit.commit_id).join(" | ")})`,
        "-T",
        revisionsTemplate,
      ],
    });
    const extra = yield* parse(extraLines);
    const toRevision = (revision: typeof RevisionOutput.Type): JjRevision => ({
      commitId: revision.commit.commit_id,
      changeId: revision.commit.change_id,
      parentIds: revision.commit.parents,
      description: revision.commit.description,
      immutable: revision.immutable,
      conflict: revision.conflict,
      empty: revision.empty,
      current: revision.current,
      files: revision.files,
      author: revision.commit.author,
      committer: revision.commit.committer,
      bookmarks: revision.bookmarks
        .filter((bookmark) => bookmark.remote === null)
        .map((bookmark) => bookmark.name),
      remoteBookmarks: revision.bookmarks.flatMap((bookmark) =>
        bookmark.remote === null ? [] : [`${bookmark.name}@${bookmark.remote}`],
      ),
      tags: revision.tags,
      conflictPaths: revision.conflictPaths,
    });
    const revisions = decoded.map(toRevision);
    if (!revisions.some((revision) => revision.commitId === wc && revision.current))
      return yield* error("invalid-output");
    const remoteLines = yield* cli({ cwd: input.cwd, args: ["git", "remote", "list"] });
    const remotes = remoteLines
      .split("\n")
      .flatMap((line) => /^(\S+)\s/.exec(line)?.[1] ?? [])
      .filter(isJjBookmarkName);
    return {
      status: "ready",
      cwd: input.cwd,
      workspaceIdentity: input.identity,
      operationId: input.operationId,
      workingCopyCommitId: wc,
      revisions,
      filesTruncated: [...decoded, ...extra.slice(0, 64)].some(
        (revision) => revision.filesTruncated,
      ),
      visibleRevisions: extra.slice(0, 64).map(toRevision),
      visibleRevisionsTruncated: extra.length > 64,
      remotes,
    } satisfies JjPanelReady;
  });
  const snapshot = Effect.fn("JjPanelService.snapshot")(function* (input: {
    cwd: string;
    identity: JjWorkspaceIdentity;
  }) {
    // Snapshot once. Every subsequent field is read from this captured repository view.
    yield* cli({ cwd: input.cwd, args: ["log", "--no-graph", "-r", "@", "-T", "json(commit_id)"] });
    const operation = yield* head(input.cwd);
    return yield* readPinned({ ...input, operationId: operation.id });
  });
  const getPanel = Effect.fn("JjPanelService.getPanel")(function* (input: JjGetPanelInput) {
    const identity = yield* resolve(input);
    if ("status" in identity) return identity;
    return yield* lockFor(identity).withPermit(snapshot({ cwd: input.cwd, identity }));
  });
  const sameIdentity = (a: JjWorkspaceIdentity, b: JjWorkspaceIdentity) =>
    a.workspaceRoot === b.workspaceRoot &&
    a.repositoryPath === b.repositoryPath &&
    a.workspaceId === b.workspaceId;
  type Mutation = JjDescribeInput | JjSquashInput | JjRevertOperationInput | JjRunActionInput;
  const mutate = Effect.fn("JjPanelService.mutate")(function* (input: {
    request: Mutation;
    action: JjActionReceipt["action"];
    prepare: (
      panel: JjPanelReady,
    ) => Effect.Effect<{ args: ReadonlyArray<string>; stdin?: string }, JjPanelError>;
  }) {
    const identity = yield* resolve(input.request);
    if ("status" in identity) return yield* error("unavailable");
    if (!sameIdentity(identity, input.request.workspaceIdentity))
      return yield* error("workspace-mismatch");
    return yield* lockFor(identity).withPermit(
      Effect.gen(function* () {
        // Resolve again under the shared-store lock in case a workspace was replaced while queued.
        const resolved = yield* resolve(input.request);
        if ("status" in resolved || !sameIdentity(identity, resolved))
          return yield* error("workspace-mismatch");
        const before = yield* snapshot({ cwd: input.request.cwd, identity });
        if (before.operationId !== input.request.expectedOperationId)
          return yield* error("stale-state");
        const command = yield* input.prepare(before);
        if ((yield* head(input.request.cwd)).id !== before.operationId)
          return yield* error("stale-state");
        const receiptId = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(() => error("command-failed")));
        const marker = `t3-jj-${receiptId}`;
        // A unique operation author lets us verify attribution without trusting a moving latest op.
        yield* cli({
          cwd: input.request.cwd,
          args: [
            "--at-operation",
            before.operationId,
            "--config",
            `operation.username=${quote(marker)}`,
            ...command.args,
          ],
          ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
        });
        const after = yield* head(input.request.cwd);
        const verified =
          after.username === marker &&
          after.parents.length === 1 &&
          after.parents[0] === before.operationId;
        if (after.id !== before.operationId && !verified)
          return yield* error("concurrent-operation");
        if (verified) {
          // Pinned mutation commands deliberately leave the filesystem stale. Update only our head.
          yield* cli({ cwd: input.request.cwd, args: ["workspace", "update-stale"] });
          if ((yield* head(input.request.cwd)).id !== after.id)
            return yield* error("concurrent-operation");
        }
        const panel = yield* readPinned({
          cwd: input.request.cwd,
          identity,
          operationId: after.id,
        });
        const receipt: JjActionReceipt = {
          receiptId,
          action: input.action,
          beforeOperationId: before.operationId,
          operationId: after.id,
          undoAvailable:
            input.action !== "push" && verified && (yield* head(input.request.cwd)).id === after.id,
        };
        if (receipt.undoAvailable) {
          receipts.set(receiptId, { identity, receipt });
          if (receipts.size > 256) {
            const oldest = receipts.keys().next().value;
            if (oldest !== undefined) receipts.delete(oldest);
          }
        }
        return { panel, receipt };
      }),
    );
  });
  const target = Effect.fn("JjPanelService.target")(function* (
    panel: JjPanelReady,
    commitId: string,
  ) {
    const revision = panel.revisions.find((item) => item.commitId === commitId);
    if (!revision) return yield* error("invalid-target");
    if (revision.immutable || /^0+$/.test(revision.commitId)) return yield* error("immutable");
    return revision;
  });
  const visibleTarget = Effect.fn("JjPanelService.visibleTarget")(function* (input: {
    panel: JjPanelReady;
    commitId: string;
    mutable?: boolean;
    clean?: boolean;
  }) {
    const revision = [...input.panel.revisions, ...(input.panel.visibleRevisions ?? [])].find(
      (item) => item.commitId === input.commitId,
    );
    if (!revision) return yield* error("invalid-target");
    if (input.mutable && revision.immutable) return yield* error("immutable");
    if (input.clean && revision.conflict) return yield* error("conflicted");
    return revision;
  });
  const selectedFiles = Effect.fn("JjPanelService.selectedFiles")(function* (input: {
    panel: JjPanelReady;
    commitId: string;
    paths?: ReadonlyArray<string> | undefined;
    allowUnchanged?: boolean;
  }) {
    if (input.paths === undefined) return [];
    if (input.paths.length === 0) return yield* error("invalid-path");
    const paths = yield* Effect.forEach(input.paths, (value) =>
      decodeFilePath(value).pipe(Effect.mapError(() => error("invalid-path"))),
    );
    const filesets = paths.map((value) => `root-file:${quote(value)}`);
    const selected = filesets.join(" | ");
    const changed = yield* decode(
      Schema.Array(Schema.String),
      yield* cli({
        cwd: input.panel.cwd,
        args: [
          "--at-operation",
          input.panel.operationId,
          "log",
          "--no-graph",
          "-r",
          input.commitId,
          "-T",
          `json(self.diff(${quote(selected)}).files().map(|f| f.path()))`,
        ],
      }),
    );
    let present: ReadonlyArray<string> = changed;
    if (input.allowUnchanged) {
      const tree = yield* cli({
        cwd: input.panel.cwd,
        args: [
          "--at-operation",
          input.panel.operationId,
          "file",
          "list",
          "-r",
          input.commitId,
          "-T",
          'json(path) ++ "\\n"',
          "--",
          ...filesets,
        ],
      });
      const entries = yield* Effect.forEach(tree.trim().split("\n").filter(Boolean), (line) =>
        decode(Schema.String, line),
      );
      present = [...changed, ...entries];
    }
    if (paths.some((value) => !present.includes(value))) return yield* error("invalid-path");
    return filesets;
  });
  const guardRewrite = Effect.fn("JjPanelService.guardRewrite")(function* (input: {
    panel: JjPanelReady;
    revset: string;
  }) {
    const immutable = yield* cli({
      cwd: input.panel.cwd,
      args: [
        "--at-operation",
        input.panel.operationId,
        "log",
        "--no-graph",
        "--limit",
        "1",
        "-r",
        `(${input.revset}) & immutable()`,
        "-T",
        "json(commit_id)",
      ],
    });
    if (immutable.trim()) return yield* error("immutable");
  });
  const runAction = Effect.fn("JjPanelService.runAction")((request: JjRunActionInput) =>
    Effect.gen(function* () {
      // Service callers (MCP/CLI) have the same validation boundary as RPC callers.
      const decoded = yield* decodeRunAction(request).pipe(
        Effect.mapError(() => error("invalid-target")),
      );
      return yield* mutate({
        request: decoded,
        action: decoded.action.type,
        prepare: Effect.fn("JjPanelService.runAction.prepare")(function* (panel) {
          const action = decoded.action;
          const revision = (commitId: string, mutable = false, clean = false) =>
            visibleTarget({ panel, commitId, mutable, clean });
          const revisions = (ids: ReadonlyArray<string>, mutable = false, clean = false) => {
            if (new Set(ids).size !== ids.length) return Effect.fail(error("invalid-target"));
            return Effect.forEach(ids, (commitId) => revision(commitId, mutable, clean));
          };
          switch (action.type) {
            case "new":
            case "merge": {
              yield* revisions(action.parentCommitIds, false, action.type === "merge");
              return { args: ["new", "--message", "", "--", ...action.parentCommitIds] };
            }
            case "commit": {
              yield* revision(panel.workingCopyCommitId, true, true);
              return { args: ["commit", "--message", action.description] };
            }
            case "edit": {
              yield* revision(action.revisionCommitId, true);
              return { args: ["edit", action.revisionCommitId] };
            }
            case "insert": {
              yield* revisions(action.revisionCommitIds, action.position === "before", true);
              const targets = action.revisionCommitIds.join(" | ");
              yield* guardRewrite({
                panel,
                revset:
                  action.position === "before"
                    ? `descendants(${targets})`
                    : `descendants(children(${targets}))`,
              });
              return {
                args: [
                  "new",
                  "--message",
                  "",
                  ...action.revisionCommitIds.flatMap((id) => [
                    action.position === "before" ? "--insert-before" : "--insert-after",
                    id,
                  ]),
                ],
              };
            }
            case "squash": {
              const source = yield* revision(action.sourceCommitId, true, true);
              yield* revision(action.destinationCommitId, action.mode === "into", true);
              if (action.sourceCommitId === action.destinationCommitId)
                return yield* error("invalid-target");
              const files = yield* selectedFiles({
                panel,
                commitId: action.sourceCommitId,
                paths: action.paths,
              });
              const policy = action.messagePolicy;
              const message =
                policy?.type === "replace"
                  ? ["--message", policy.description]
                  : action.mode === "onto"
                    ? ["--message", source.description]
                    : ["--use-destination-message"];
              return {
                args: [
                  "squash",
                  "--from",
                  action.sourceCommitId,
                  action.mode === "onto" ? "--onto" : "--into",
                  action.destinationCommitId,
                  ...message,
                  "--",
                  ...files,
                ],
              };
            }
            case "absorb": {
              yield* revision(action.revisionCommitId, true, true);
              const files = yield* selectedFiles({
                panel,
                commitId: action.revisionCommitId,
                paths: action.paths,
              });
              return {
                args: [
                  "absorb",
                  "--from",
                  action.revisionCommitId,
                  "--into",
                  `ancestors(${action.revisionCommitId}) & mutable() ~ conflicts()`,
                  "--",
                  ...files,
                ],
              };
            }
            case "rebase": {
              yield* revision(action.revisionCommitId, true, true);
              yield* revisions(action.destinationCommitIds, false, true);
              if (action.destinationCommitIds.includes(action.revisionCommitId))
                return yield* error("invalid-target");
              if (action.mode === "branch")
                yield* guardRewrite({
                  panel,
                  revset: `descendants(${action.revisionCommitId})`,
                });
              return {
                args: [
                  "rebase",
                  action.mode === "branch" ? "--source" : "--revision",
                  action.revisionCommitId,
                  ...action.destinationCommitIds.flatMap((id) => ["--onto", id]),
                ],
              };
            }
            case "duplicate": {
              yield* revision(action.revisionCommitId, false, true);
              if (action.destinationCommitIds)
                yield* revisions(action.destinationCommitIds, false, true);
              return {
                args: [
                  "duplicate",
                  action.revisionCommitId,
                  ...(action.destinationCommitIds ?? []).flatMap((id) => ["--onto", id]),
                ],
              };
            }
            case "abandon": {
              yield* revisions(action.revisionCommitIds, true);
              return { args: ["abandon", "--", ...action.revisionCommitIds] };
            }
            case "restore": {
              yield* revision(action.revisionCommitId, true);
              const files = yield* selectedFiles({
                panel,
                commitId: action.revisionCommitId,
                paths: action.paths,
                allowUnchanged: true,
              });
              return {
                args: ["restore", "--changes-in", action.revisionCommitId, "--", ...files],
              };
            }
            case "undo":
            case "redo":
              return { args: [action.type] };
            case "bookmark-set":
            case "bookmark-advance": {
              yield* revision(action.revisionCommitId, false, true);
              return {
                args:
                  action.type === "bookmark-set"
                    ? [
                        "bookmark",
                        "set",
                        "--allow-backwards",
                        "--revision",
                        action.revisionCommitId,
                        "--",
                        action.name,
                      ]
                    : [
                        "bookmark",
                        "advance",
                        "--to",
                        action.revisionCommitId,
                        "--",
                        `exact:${action.name}`,
                      ],
              };
            }
            case "bookmark-delete":
              return { args: ["bookmark", "delete", "--", `exact:${action.name}`] };
            case "push":
              return {
                args: [
                  "git",
                  "push",
                  "--remote",
                  action.remote,
                  ...action.bookmarkNames.flatMap((name) => ["--bookmark", `exact:${name}`]),
                ],
              };
          }
        }),
      });
    }),
  );
  const getDiff = Effect.fn("JjPanelService.getDiff")(function* (request: JjGetDiffInput) {
    const input = yield* decodeGetDiff(request).pipe(
      Effect.mapError(() => error("invalid-target")),
    );
    const identity = yield* resolve(input);
    if ("status" in identity) return yield* error("unavailable");
    if (!sameIdentity(identity, input.workspaceIdentity)) return yield* error("workspace-mismatch");
    return yield* lockFor(identity).withPermit(
      Effect.gen(function* () {
        const resolved = yield* resolve(input);
        if ("status" in resolved || !sameIdentity(identity, resolved))
          return yield* error("workspace-mismatch");
        const panel = yield* snapshot({ cwd: input.cwd, identity });
        if (panel.operationId !== input.expectedOperationId) return yield* error("stale-state");
        const exists = yield* cli({
          cwd: input.cwd,
          args: [
            "--at-operation",
            panel.operationId,
            "log",
            "--no-graph",
            "--limit",
            "1",
            "-r",
            `${input.revisionCommitId} & all()`,
            "-T",
            "json(commit_id)",
          ],
        });
        if (!exists.trim()) return yield* error("invalid-target");
        const files = yield* selectedFiles({
          panel,
          commitId: input.revisionCommitId,
          ...(input.filePath !== undefined ? { paths: [input.filePath] } : {}),
        });
        const output = yield* process
          .run({
            operation: "JjPanelService.getDiff",
            command: "jj",
            cwd: input.cwd,
            args: [
              "--no-pager",
              "--color=never",
              "--at-operation",
              panel.operationId,
              "diff",
              "--git",
              "--revision",
              input.revisionCommitId,
              "--",
              ...files,
            ],
            outputMode: "truncate",
            maxOutputBytes: 1_000_000,
            appendTruncationMarker: false,
          })
          .pipe(Effect.mapError(() => error("command-failed")));
        if (output.stdoutInvalidUtf8) return yield* error("invalid-output");
        return {
          diff: output.stdout,
          operationId: panel.operationId,
          commitId: input.revisionCommitId,
          truncated: output.stdoutTruncated,
        } satisfies JjDiffResult;
      }),
    );
  });
  const describe = Effect.fn("JjPanelService.describe")((request: JjDescribeInput) =>
    mutate({
      request,
      action: "describe",
      prepare: Effect.fn("JjPanelService.describe.prepare")(function* (panel) {
        yield* target(panel, request.revisionCommitId);
        return {
          args: ["describe", request.revisionCommitId, "--stdin"],
          stdin: request.description,
        };
      }),
    }),
  );
  const squash = Effect.fn("JjPanelService.squash")((request: JjSquashInput) =>
    mutate({
      request,
      action: "squash",
      prepare: Effect.fn("JjPanelService.squash.prepare")(function* (panel) {
        const source = yield* target(panel, request.sourceCommitId);
        const destination = yield* target(panel, request.destinationCommitId);
        if (source.conflict || destination.conflict) return yield* error("conflicted");
        if (source.commitId === destination.commitId) return yield* error("invalid-target");
        const ancestorOutput = yield* cli({
          cwd: request.cwd,
          args: [
            "--at-operation",
            panel.operationId,
            "log",
            "--no-graph",
            "-r",
            `${destination.commitId} & ancestors(${source.commitId})`,
            "-T",
            'json(commit_id) ++ "\\n"',
          ],
        });
        const ancestors = yield* decode(
          Schema.Array(JjCommitId),
          `[${ancestorOutput.trim().split("\n").filter(Boolean).join(",")}]`,
        );
        if (!ancestors.includes(destination.commitId)) return yield* error("invalid-target");
        const policy = request.messagePolicy;
        return {
          args: [
            "squash",
            "--from",
            source.commitId,
            "--into",
            destination.commitId,
            ...(policy?.type === "replace"
              ? ["--message", policy.description]
              : ["--use-destination-message"]),
          ],
        };
      }),
    }),
  );
  const revertOperation = Effect.fn("JjPanelService.revertOperation")(
    (request: JjRevertOperationInput) =>
      mutate({
        request,
        action: "revert-operation",
        prepare: Effect.fn("JjPanelService.revertOperation.prepare")(function* () {
          const owned = receipts.get(request.receiptId);
          if (
            !owned ||
            !owned.receipt.undoAvailable ||
            !sameIdentity(owned.identity, request.workspaceIdentity) ||
            owned.receipt.operationId !== request.operationId ||
            request.operationId !== request.expectedOperationId
          )
            return yield* error("invalid-receipt");
          return { args: ["op", "revert", request.operationId] };
        }),
      }),
  );
  return JjPanelService.of({ getPanel, describe, squash, revertOperation, runAction, getDiff });
});
export const layer = Layer.effect(JjPanelService, make);
