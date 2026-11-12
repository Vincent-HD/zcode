import * as SecureRandom from "effect/crypto/SecureRandom";
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
  JjGetPanelInput,
  type JjDiffResult,
  type JjLogRow,
  type JjLogView,
  type JjWorkspaceIdentity,
  type JjPanelReady,
  type JjPanelSnapshot,
  type JjRevisionDetails,
  type JjGetRevisionInput,
  type JjDescribeInput,
  type JjSquashInput,
  type JjRevertOperationInput,
  type JjMutationResult,
  type JjActionReceipt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const DEFAULT_LOG_LIMIT = 100;
// Each elided row adds a revset to the one follow-up query; deeper rows render as truncated.
const MAX_ELIDED_ROWS = 64;
const MAX_DETAIL_FILES = 512;

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const jsonObjectTemplate = (fields: Readonly<Record<string, string>>) =>
  `${quote("{")} ++ ${Object.entries(fields)
    .map(([key, value]) => `${quote(`${quote(key)}:`)} ++ ${value}`)
    .join(` ++ ${quote(",")} ++ `)} ++ ${quote("}")}`;
const jsonArrayTemplate = (items: ReadonlyArray<string>) =>
  `${quote("[")} ++ ${items.join(` ++ ${quote(",")} ++ `)} ++ ${quote("]")}`;
// jj's `bookmarks` keyword lists a remote bookmark only where it differs from the local one.
const bookmarksTemplate = `${quote("[")} ++ bookmarks.take(64).map(|b| ${jsonArrayTemplate([
  "json(b.name())",
  `if(b.remote(), json(b.remote()), ${quote("null")})`,
])}).join(",") ++ ${quote("]")}`;
const flagsTemplate = `${quote('"')} ++ ${[
  ["current_working_copy", "c"],
  ["immutable", "i"],
  ["conflict", "x"],
  ["empty", "e"],
  ["divergent", "d"],
  ["hidden", "h"],
  ["root", "r"],
]
  .map(([keyword, letter]) => `if(${keyword}, ${quote(letter!)})`)
  .join(" ++ ")} ++ ${quote('"')}`;

/** One positional JSON array per row keeps jj's output and our parse small. */
const rowTemplate = (revset: string) =>
  `${jsonArrayTemplate([
    "json(commit_id)",
    "json(change_id)",
    "json(parents.map(|p| p.commit_id()))",
    `json(parents.map(|p| p.contained_in(${quote(revset)})))`,
    "json(description.first_line())",
    "json(author)",
    "json(change_id.shortest().prefix().len())",
    "json(commit_id.shortest().prefix().len())",
    `if(divergent, json(change_offset), ${quote("null")})`,
    flagsTemplate,
    bookmarksTemplate,
    "json(tags.take(64).map(|t| t.name()))",
    "json(working_copies.map(|w| w.name()))",
  ])} ++ "\\n"`;
const RowOutput = Schema.Tuple([
  JjCommitId,
  JjChangeId,
  Schema.Array(JjCommitId),
  Schema.Array(Schema.Boolean),
  Schema.String,
  JjSignature,
  Schema.Number,
  Schema.Number,
  Schema.NullOr(Schema.Number),
  Schema.String,
  Schema.Array(Schema.Tuple([Schema.String, Schema.NullOr(Schema.String)])),
  Schema.Array(Schema.String),
  Schema.Array(Schema.String),
]);
type RowOutput = typeof RowOutput.Type;
const targetTemplate = `${jsonArrayTemplate([
  "json(commit_id)",
  "json(parents.map(|p| p.commit_id()))",
  "json(description)",
  flagsTemplate,
  "json(local_bookmarks.map(|b| b.name()))",
])} ++ "\\n"`;
const TargetOutput = Schema.Tuple([
  JjCommitId,
  Schema.Array(JjCommitId),
  Schema.String,
  Schema.String,
  Schema.Array(Schema.String),
]);
const fileTemplate = jsonObjectTemplate({ path: "json(f.path())", status: "json(f.status())" });
const detailsTemplate = jsonObjectTemplate({
  commitId: "json(commit_id)",
  changeId: "json(change_id)",
  description: "json(description)",
  author: "json(author)",
  committer: "json(committer)",
  files: `${quote("[")} ++ diff.files().take(${MAX_DETAIL_FILES}).map(|f| ${fileTemplate}).join(",") ++ ${quote("]")}`,
  filesTruncated: `json(diff.files().len() > ${MAX_DETAIL_FILES})`,
  conflictPaths: `json(conflicted_files.take(${MAX_DETAIL_FILES}).map(|f| f.path()))`,
});
const DetailsOutput = Schema.Struct({
  commitId: JjCommitId,
  changeId: JjChangeId,
  description: Schema.String,
  author: JjSignature,
  committer: JjSignature,
  files: Schema.Array(JjChangedFile),
  filesTruncated: Schema.Boolean,
  conflictPaths: Schema.Array(Schema.String),
});
const Operation = Schema.Struct({
  id: JjOperationId,
  parents: Schema.Array(JjOperationId),
  username: Schema.String,
  description: Schema.String,
});
type Operation = typeof Operation.Type;

/** Revision facts mutations and publication validate against, read at a pinned operation. */
export interface JjRevisionTarget {
  readonly commitId: string;
  readonly parentIds: ReadonlyArray<string>;
  readonly description: string;
  readonly immutable: boolean;
  readonly conflict: boolean;
  readonly current: boolean;
  readonly hidden: boolean;
  readonly bookmarks: ReadonlyArray<string>;
}

interface Page {
  readonly rows: ReadonlyArray<JjLogRow>;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly workingCopyCommitId: string;
  readonly remotes: ReadonlyArray<string>;
}

const error = (reason: JjPanelError["reason"], detail?: string) =>
  new JjPanelError({ reason, ...(detail ? { detail } : {}) });
const decodeFilePath = Schema.decodeUnknownEffect(JjFilePath);
const isJjBookmarkName = Schema.is(JjBookmarkName);
const isJjPanelError = Schema.is(JjPanelError);
const decodeRunAction = Schema.decodeUnknownEffect(JjRunActionInput);
const decodeGetDiff = Schema.decodeUnknownEffect(JjGetDiffInput);
const decodeGetPanel = Schema.decodeUnknownEffect(JjGetPanelInput);
const decodeCommitId = Schema.decodeEffect(JjCommitId);
const decodeRowLine = Schema.decodeUnknownEffect(Schema.fromJsonString(RowOutput));

/** jj's own `Error:` line plus its first cause, which name the revset or rule that failed. */
export const jjErrorDetail = (stderr: string) => {
  const lines = stderr.split("\n").map((line) => line.trim());
  const index = lines.findIndex((line) => line.startsWith("Error:"));
  if (index === -1) return undefined;
  const cause = lines[index + 1]?.startsWith("Caused by:") ? ` ${lines[index + 1]}` : "";
  return `${lines[index]!.slice("Error:".length).trim()}${cause}`.slice(0, 300);
};

const flagSet = (flags: string) => ({
  current: flags.includes("c"),
  immutable: flags.includes("i"),
  conflict: flags.includes("x"),
  empty: flags.includes("e"),
  divergent: flags.includes("d"),
  hidden: flags.includes("h"),
  root: flags.includes("r"),
});

/** Maps one decoded jj row to its wire shape, omitting false flags and empty lists. */
export const toLogRow = (
  output: RowOutput,
  nearest: ReadonlyArray<string> | "truncated" | undefined,
): JjLogRow => {
  const [commitId, changeId, parentIds, parentsInRevset, summary, author] = output;
  const [, , , , , , changePrefixLength, commitPrefixLength, changeOffset, flags] = output;
  const [, , , , , , , , , , bookmarks, tags, workingCopies] = output;
  const local = bookmarks.flatMap(([name, remote]) => (remote === null ? [name] : []));
  const remote = bookmarks.flatMap(([name, origin]) =>
    origin === null ? [] : [`${name}@${origin}`],
  );
  const uniqueTags = [...new Set(tags)];
  const set = flagSet(flags);
  const outside = parentsInRevset.some((inside) => !inside);
  const edges =
    !outside || nearest === undefined
      ? undefined
      : nearest === "truncated"
        ? parentIds.filter((_, index) => parentsInRevset[index]).map((id) => ({ commitId: id }))
        : nearest.map((id) =>
            parentIds.includes(id) ? { commitId: id } : { commitId: id, elided: true },
          );
  const truncated = outside && (nearest === "truncated" || nearest?.length === 0);
  return {
    commitId,
    changeId,
    parentIds,
    ...(edges ? { edges } : {}),
    ...(truncated ? { edgesTruncated: true } : {}),
    summary,
    author,
    changePrefixLength,
    commitPrefixLength,
    ...(set.divergent && changeOffset !== null ? { changeOffset } : {}),
    ...Object.fromEntries(Object.entries(set).filter(([, value]) => value)),
    ...(local.length ? { bookmarks: local } : {}),
    ...(remote.length ? { remoteBookmarks: remote } : {}),
    ...(uniqueTags.length ? { tags: uniqueTags } : {}),
    ...(workingCopies.length ? { workingCopies } : {}),
  };
};

export class JjPanelService extends Context.Service<
  JjPanelService,
  {
    readonly getPanel: (input: JjGetPanelInput) => Effect.Effect<JjPanelSnapshot, JjPanelError>;
    readonly getRevision: (
      input: JjGetRevisionInput,
    ) => Effect.Effect<JjRevisionDetails, JjPanelError>;
    readonly runAction: (input: JjRunActionInput) => Effect.Effect<JjMutationResult, JjPanelError>;
    readonly getDiff: (input: JjGetDiffInput) => Effect.Effect<JjDiffResult, JjPanelError>;
    readonly describe: (input: JjDescribeInput) => Effect.Effect<JjMutationResult, JjPanelError>;
    readonly squash: (input: JjSquashInput) => Effect.Effect<JjMutationResult, JjPanelError>;
    readonly revertOperation: (
      input: JjRevertOperationInput,
    ) => Effect.Effect<JjMutationResult, JjPanelError>;
    /** Snapshots the working copy and reads the current operation, for publication freshness. */
    readonly currentOperation: (input: {
      cwd: string;
    }) => Effect.Effect<
      { cwd: string; workspaceIdentity: JjWorkspaceIdentity; operationId: string },
      JjPanelError
    >;
    readonly lookupRevisions: (input: {
      cwd: string;
      operationId: string;
      commitIds: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<JjRevisionTarget>, JjPanelError>;
  }
>()("t3/jj/JjPanelService") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  // Repository-scoped resource locks never expire while queued users still hold them.
  const locks = new Map<string, Semaphore.Semaphore>();
  const receipts = new Map<string, { identity: JjWorkspaceIdentity; receipt: JjActionReceipt }>();
  const inflightHeads = new Map<string, Deferred.Deferred<Operation, JjPanelError>>();
  const inflightPages = new Map<string, Deferred.Deferred<Page, JjPanelError>>();
  // Pages are immutable per operation, so a page cache never needs invalidation, only bounds.
  const pages = new Map<string, Page>();
  // Commit ids address content: their description, files and conflicts never change.
  const details = new Map<string, JjRevisionDetails>();
  const configuredRevsets = new Map<string, string>();
  const remember = <V>(cache: Map<string, V>, key: string, value: V, bound: number) => {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > bound) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };
  /** Concurrent callers with the same key share one execution and its result. */
  const coalesce = <A>(
    inflight: Map<string, Deferred.Deferred<A, JjPanelError>>,
    key: string,
    effect: Effect.Effect<A, JjPanelError>,
  ) =>
    Effect.suspend(() => {
      const existing = inflight.get(key);
      if (existing) return Deferred.await(existing);
      const deferred = Deferred.makeUnsafe<A, JjPanelError>();
      inflight.set(key, deferred);
      return effect.pipe(
        Effect.onExit((exit) => {
          inflight.delete(key);
          return Deferred.done(deferred, exit);
        }),
      );
    });

  const run = Effect.fn("JjPanelService.run")(function* (input: {
    cwd: string;
    args: ReadonlyArray<string>;
    stdin?: string;
    failure?: JjPanelError["reason"];
  }) {
    const output = yield* process
      .run({
        operation: "JjPanelService.cli",
        command: "jj",
        cwd: input.cwd,
        args: ["--no-pager", "--color=never", ...input.args],
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        allowNonZeroExit: true,
        outputMode: "error",
        maxOutputBytes: 4_000_000,
      })
      .pipe(
        Effect.catchTags({ VcsProcessSpawnError: () => Effect.fail(error("unavailable")) }),
        Effect.mapError((cause) => (isJjPanelError(cause) ? cause : error("command-failed"))),
      );
    if (output.exitCode !== 0)
      return yield* error(input.failure ?? "command-failed", jjErrorDetail(output.stderr));
    if (output.stdoutInvalidUtf8 || output.stdoutTruncated) return yield* error("invalid-output");
    return output.stdout;
  });
  const decode = <S extends Schema.Top>(schema: S, value: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError(() => error("invalid-output")),
    );
  const lines = (output: string) => output.split("\n").filter(Boolean);

  const resolve = Effect.fn("JjPanelService.resolve")(function* (
    cwd: string,
  ): Effect.fn.Return<
    JjWorkspaceIdentity | Extract<JjPanelSnapshot, { status: "unavailable" }>,
    JjPanelError
  > {
    // The directory holding `.jj` is the workspace root, so resolving needs no jj process.
    const failed = () => error("command-failed");
    let directory = yield* fs.realPath(cwd).pipe(Effect.mapError(failed));
    while (!(yield* fs.exists(path.join(directory, ".jj")).pipe(Effect.mapError(failed)))) {
      const parent = path.dirname(directory);
      if (parent === directory)
        return { status: "unavailable", cwd, reason: "not-jj-workspace" } satisfies JjPanelSnapshot;
      directory = parent;
    }
    const repoEntry = path.join(directory, ".jj", "repo");
    const repoInfo = yield* fs.stat(repoEntry).pipe(Effect.mapError(failed));
    const repoLocation =
      repoInfo.type === "File"
        ? path.resolve(
            path.dirname(repoEntry),
            (yield* fs.readFileString(repoEntry).pipe(Effect.mapError(failed))).trim(),
          )
        : repoEntry;
    const repositoryPath = yield* fs.realPath(repoLocation).pipe(Effect.mapError(failed));
    const wcInfo = yield* fs
      .stat(path.join(directory, ".jj", "working_copy"))
      .pipe(Effect.mapError(failed));
    return {
      workspaceRoot: directory,
      repositoryPath,
      workspaceId: `${directory}:${wcInfo.dev}:${Option.getOrElse(wcInfo.ino, () => 0)}`,
    } satisfies JjWorkspaceIdentity;
  });
  const lockFor = (identity: JjWorkspaceIdentity) => {
    const existing = locks.get(identity.repositoryPath);
    if (existing) return existing;
    const lock = Semaphore.makeUnsafe(1);
    locks.set(identity.repositoryPath, lock);
    return lock;
  };
  const head = Effect.fn("JjPanelService.head")(function* (input: {
    cwd: string;
    snapshot?: boolean;
  }) {
    // Without --ignore-working-copy, `op log` snapshots first and reports the resulting head.
    return yield* decode(
      Operation,
      yield* run({
        cwd: input.cwd,
        args: [
          ...(input.snapshot ? [] : ["--ignore-working-copy", "--at-operation", "@"]),
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
  const snapshotHead = (cwd: string, identity: JjWorkspaceIdentity) =>
    coalesce(
      inflightHeads,
      `head\0${identity.workspaceId}`,
      lockFor(identity).withPermit(head({ cwd, snapshot: true })),
    );
  const pinned = (operationId: string) => ["--ignore-working-copy", "--at-operation", operationId];

  const configuredRevset = Effect.fn("JjPanelService.configuredRevset")(function* (input: {
    cwd: string;
    workspaceRoot: string;
    reload: boolean;
  }) {
    const cached = configuredRevsets.get(input.workspaceRoot);
    if (cached !== undefined && !input.reload) return cached;
    const value = (yield* run({
      cwd: input.cwd,
      args: ["--ignore-working-copy", "config", "get", "revsets.log"],
    })).trim();
    const revset = value || "builtin_log()";
    remember(configuredRevsets, input.workspaceRoot, revset, 64);
    return revset;
  });

  /** Nearest in-revset ancestors for rows whose parents leave the revset, in one jj call. */
  const elide = Effect.fn("JjPanelService.elide")(function* (input: {
    cwd: string;
    operationId: string;
    revset: string;
    commitIds: ReadonlyArray<string>;
  }) {
    const nearest = new Map(input.commitIds.map((id) => [id, [] as string[]]));
    if (!input.commitIds.length) return nearest;
    const revsets = input.commitIds.map((id) => `heads(::(${id}-) & (${input.revset}))`);
    const output = yield* run({
      cwd: input.cwd,
      failure: "invalid-revset",
      args: [
        ...pinned(input.operationId),
        "log",
        "--no-graph",
        "-r",
        revsets.join(" | "),
        "-T",
        `commit_id ++ ${revsets
          .map((revset, index) => `if(self.contained_in(${quote(revset)}), ${quote(` ${index}`)})`)
          .join(" ++ ")} ++ "\\n"`,
      ],
    });
    for (const line of lines(output)) {
      const [ancestor, ...indexes] = line.trim().split(" ");
      for (const index of indexes)
        nearest.get(input.commitIds[Number(index)] ?? "")?.push(ancestor!);
    }
    return nearest;
  });

  const remotes = Effect.fn("JjPanelService.remotes")(function* (input: {
    cwd: string;
    operationId: string;
  }) {
    const output = yield* run({
      cwd: input.cwd,
      args: [...pinned(input.operationId), "git", "remote", "list"],
    });
    return output
      .split("\n")
      .flatMap((line) => /^(\S+)\s/.exec(line)?.[1] ?? [])
      .filter(isJjBookmarkName);
  });

  const readPage = Effect.fn("JjPanelService.readPage")(function* (input: {
    cwd: string;
    identity: JjWorkspaceIdentity;
    operationId: string;
    revset: string;
    limit: number;
  }) {
    const key = `${input.identity.workspaceId}\0${input.operationId}\0${input.revset}`;
    const cached = pages.get(key);
    if (cached && (cached.limit >= input.limit || !cached.hasMore)) return cached;
    return yield* coalesce(
      inflightPages,
      `page\0${key}\0${input.limit}`,
      Effect.gen(function* () {
        // The working copy is always listed so the panel can anchor on it.
        const revset = `(${input.revset}) | present(@)`;
        const [output, remoteNames] = yield* Effect.all(
          [
            run({
              cwd: input.cwd,
              failure: "invalid-revset",
              args: [
                ...pinned(input.operationId),
                "log",
                "--no-graph",
                "--limit",
                String(input.limit + 1),
                "-r",
                revset,
                "-T",
                rowTemplate(revset),
              ],
            }),
            cached
              ? Effect.succeed(cached.remotes)
              : remotes({ cwd: input.cwd, operationId: input.operationId }),
          ],
          { concurrency: "unbounded" },
        );
        const decoded = yield* Effect.forEach(lines(output), (line) =>
          decodeRowLine(line).pipe(Effect.mapError(() => error("invalid-output"))),
        );
        const hasMore = decoded.length > input.limit;
        const listed = decoded.slice(0, input.limit);
        const outside = listed
          .filter((row) => row[3].some((inside) => !inside))
          .map((row) => row[0]);
        const nearest = yield* elide({
          cwd: input.cwd,
          operationId: input.operationId,
          revset,
          commitIds: outside.slice(0, MAX_ELIDED_ROWS),
        });
        const rows = listed.map((row) =>
          toLogRow(
            row,
            nearest.get(row[0]) ?? (outside.includes(row[0]) ? "truncated" : undefined),
          ),
        );
        const workingCopyCommitId =
          rows.find((row) => row.current)?.commitId ??
          (yield* decode(
            JjCommitId,
            yield* run({
              cwd: input.cwd,
              args: [
                ...pinned(input.operationId),
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "json(commit_id)",
              ],
            }),
          ));
        const page: Page = {
          rows,
          limit: input.limit,
          hasMore,
          workingCopyCommitId,
          remotes: remoteNames,
        };
        remember(pages, key, page, 8);
        return page;
      }),
    );
  });

  const ready = (input: {
    cwd: string;
    identity: JjWorkspaceIdentity;
    operation: Operation;
    revset: string;
    page: Page;
    offset: number;
    limit: number;
  }): JjPanelReady => ({
    status: "ready",
    cwd: input.cwd,
    workspaceIdentity: input.identity,
    operationId: input.operation.id,
    operationDescription: input.operation.description,
    workingCopyCommitId: input.page.workingCopyCommitId,
    revset: input.revset,
    offset: input.offset,
    rows: input.page.rows.slice(input.offset, input.limit),
    hasMore: input.page.hasMore || input.page.rows.length > input.limit,
    remotes: input.page.remotes,
  });

  const viewPanel = Effect.fn("JjPanelService.viewPanel")(function* (input: {
    cwd: string;
    identity: JjWorkspaceIdentity;
    operation: Operation;
    view: JjLogView | undefined;
  }) {
    const revset =
      input.view?.revset ??
      (yield* configuredRevset({
        cwd: input.cwd,
        workspaceRoot: input.identity.workspaceRoot,
        reload: false,
      }));
    const limit = input.view?.limit ?? DEFAULT_LOG_LIMIT;
    const page = yield* readPage({
      cwd: input.cwd,
      identity: input.identity,
      operationId: input.operation.id,
      revset,
      limit,
    });
    return ready({ ...input, revset, page, offset: 0, limit });
  });

  const getPanel = Effect.fn("JjPanelService.getPanel")(function* (request: JjGetPanelInput) {
    const input = yield* decodeGetPanel(request).pipe(
      Effect.mapError(() => error("invalid-revset")),
    );
    const identity = yield* resolve(input.cwd);
    if ("status" in identity) return identity;
    const limit = input.limit ?? DEFAULT_LOG_LIMIT;
    const known = input.knownOperationId;
    const head = yield* Effect.all(
      [
        snapshotHead(input.cwd, identity),
        input.revset !== undefined
          ? Effect.succeed(input.revset)
          : configuredRevset({
              cwd: input.cwd,
              workspaceRoot: identity.workspaceRoot,
              reload: known === undefined,
            }),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.asSome,
      Effect.catchIf(
        (cause) => cause.reason === "unavailable",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isNone(head))
      return {
        status: "unavailable",
        cwd: input.cwd,
        reason: "missing-executable",
      } satisfies JjPanelSnapshot;
    const [operation, revset] = head.value;
    const loaded = known === operation.id ? (input.loadedCount ?? 0) : 0;
    const exhausted = pages.get(`${identity.workspaceId}\0${operation.id}\0${revset}`);
    if (
      known === operation.id &&
      (loaded >= limit || (exhausted && !exhausted.hasMore && loaded >= exhausted.rows.length))
    )
      return {
        status: "unchanged",
        cwd: input.cwd,
        operationId: operation.id,
      } satisfies JjPanelSnapshot;
    const page = yield* readPage({
      cwd: input.cwd,
      identity,
      operationId: operation.id,
      revset,
      limit,
    });
    return ready({
      cwd: input.cwd,
      identity,
      operation,
      revset,
      page,
      offset: Math.min(loaded, page.rows.length),
      limit,
    });
  });

  const getRevision = Effect.fn("JjPanelService.getRevision")(function* (
    input: JjGetRevisionInput,
  ) {
    const identity = yield* resolve(input.cwd);
    if ("status" in identity) return yield* error("unavailable");
    const key = `${identity.repositoryPath}\0${input.commitId}`;
    const cached = details.get(key);
    if (cached) return cached;
    const output = yield* run({
      cwd: input.cwd,
      failure: "invalid-target",
      args: [
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        `present(${input.commitId})`,
        "-T",
        detailsTemplate,
      ],
    });
    if (!output.trim()) return yield* error("invalid-target");
    const value = yield* decode(DetailsOutput, output);
    remember(details, key, value, 256);
    return value;
  });

  const lookupRevisions = Effect.fn("JjPanelService.lookupRevisions")(function* (input: {
    cwd: string;
    operationId: string;
    commitIds: ReadonlyArray<string>;
  }) {
    const ids = yield* Effect.forEach(input.commitIds, (id) =>
      decodeCommitId(id).pipe(Effect.mapError(() => error("invalid-target"))),
    );
    const output = yield* run({
      cwd: input.cwd,
      args: [
        ...pinned(input.operationId),
        "log",
        "--no-graph",
        "-r",
        [...ids.map((id) => `present(${id})`), "present(@)"].join(" | "),
        "-T",
        targetTemplate,
      ],
    });
    return yield* Effect.forEach(lines(output), (line) =>
      decode(TargetOutput, line).pipe(
        Effect.map(([commitId, parentIds, description, flags, bookmarks]): JjRevisionTarget => {
          const set = flagSet(flags);
          return {
            commitId,
            parentIds,
            description,
            immutable: set.immutable || set.root,
            conflict: set.conflict,
            current: set.current,
            hidden: set.hidden,
            bookmarks,
          };
        }),
      ),
    );
  });

  const currentOperation = Effect.fn("JjPanelService.currentOperation")(function* (input: {
    cwd: string;
  }) {
    const identity = yield* resolve(input.cwd);
    if ("status" in identity) return yield* error("unavailable");
    const operation = yield* snapshotHead(input.cwd, identity);
    return { cwd: input.cwd, workspaceIdentity: identity, operationId: operation.id };
  });

  const sameIdentity = (a: JjWorkspaceIdentity, b: JjWorkspaceIdentity) =>
    a.workspaceRoot === b.workspaceRoot &&
    a.repositoryPath === b.repositoryPath &&
    a.workspaceId === b.workspaceId;
  type Mutation = JjDescribeInput | JjSquashInput | JjRevertOperationInput | JjRunActionInput;
  interface Prepared {
    readonly cwd: string;
    readonly operationId: string;
    readonly targets: (
      ids: ReadonlyArray<string>,
      options?: { mutable?: boolean; clean?: boolean },
    ) => Effect.Effect<ReadonlyArray<JjRevisionTarget>, JjPanelError>;
    readonly workingCopy: () => Effect.Effect<JjRevisionTarget, JjPanelError>;
  }
  const mutate = Effect.fn("JjPanelService.mutate")(function* (input: {
    request: Mutation;
    action: JjActionReceipt["action"];
    prepare: (
      context: Prepared,
    ) => Effect.Effect<{ args: ReadonlyArray<string>; stdin?: string }, JjPanelError>;
  }) {
    const cwd = input.request.cwd;
    const identity = yield* resolve(cwd);
    if ("status" in identity) return yield* error("unavailable");
    if (!sameIdentity(identity, input.request.workspaceIdentity))
      return yield* error("workspace-mismatch");
    return yield* lockFor(identity).withPermit(
      Effect.gen(function* () {
        // Resolve again under the shared-store lock in case a workspace was replaced while queued.
        const resolved = yield* resolve(cwd);
        if ("status" in resolved || !sameIdentity(identity, resolved))
          return yield* error("workspace-mismatch");
        const before = yield* head({ cwd, snapshot: true });
        if (before.id !== input.request.expectedOperationId) return yield* error("stale-state");
        // One pinned query reads every revision the action names, plus the working copy.
        const known = new Map<string, JjRevisionTarget>();
        const lookup = Effect.fn("JjPanelService.mutate.lookup")(function* (
          ids: ReadonlyArray<string>,
        ) {
          const missing = ids.filter((id) => !known.has(id));
          if (missing.length || !known.size)
            for (const target of yield* lookupRevisions({
              cwd,
              operationId: before.id,
              commitIds: missing.filter((id) => id !== "@"),
            })) {
              known.set(target.commitId, target);
              if (target.current) known.set("@", target);
            }
          return ids.map((id) => known.get(id));
        });
        const context: Prepared = {
          cwd,
          operationId: before.id,
          targets: Effect.fn("JjPanelService.mutate.targets")(function* (ids, options) {
            if (new Set(ids).size !== ids.length) return yield* error("invalid-target");
            const found = yield* lookup(ids);
            return yield* Effect.forEach(found, (target) => {
              if (!target || target.hidden) return Effect.fail(error("invalid-target"));
              if (options?.mutable && target.immutable) return Effect.fail(error("immutable"));
              if (options?.clean && target.conflict) return Effect.fail(error("conflicted"));
              return Effect.succeed(target);
            });
          }),
          workingCopy: () =>
            lookup(["@"]).pipe(
              Effect.flatMap(([target]) =>
                target ? Effect.succeed(target) : Effect.fail(error("invalid-target")),
              ),
            ),
        };
        const command = yield* input.prepare(context);
        const receiptId = yield* random.uuidV4();
        const marker = `t3-jj-${receiptId}`;
        // A unique operation author lets us verify attribution without trusting a moving latest op.
        yield* run({
          cwd,
          args: [
            "--at-operation",
            before.id,
            "--config",
            `operation.username=${quote(marker)}`,
            ...command.args,
          ],
          ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
        });
        const after = yield* head({ cwd });
        const verified =
          after.username === marker && after.parents.length === 1 && after.parents[0] === before.id;
        if (after.id !== before.id && !verified) return yield* error("concurrent-operation");
        if (verified) {
          // Pinned mutation commands deliberately leave the filesystem stale. Update only our head.
          yield* run({ cwd, args: ["workspace", "update-stale"] });
          if ((yield* head({ cwd })).id !== after.id) return yield* error("concurrent-operation");
        }
        const panel = yield* viewPanel({
          cwd,
          identity,
          operation: after,
          view: input.request.view,
        });
        const receipt: JjActionReceipt = {
          receiptId,
          action: input.action,
          beforeOperationId: before.id,
          operationId: after.id,
          undoAvailable:
            input.action !== "push" && verified && (yield* head({ cwd })).id === after.id,
        };
        if (receipt.undoAvailable) remember(receipts, receiptId, { identity, receipt }, 256);
        return { panel, receipt };
      }),
    );
  });

  const selectedFiles = Effect.fn("JjPanelService.selectedFiles")(function* (input: {
    cwd: string;
    operationId: string;
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
      yield* run({
        cwd: input.cwd,
        args: [
          ...pinned(input.operationId),
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
      const tree = yield* run({
        cwd: input.cwd,
        args: [
          ...pinned(input.operationId),
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
      const entries = yield* Effect.forEach(lines(tree), (line) => decode(Schema.String, line));
      present = [...changed, ...entries];
    }
    if (paths.some((value) => !present.includes(value))) return yield* error("invalid-path");
    return filesets;
  });
  const guardRewrite = Effect.fn("JjPanelService.guardRewrite")(function* (input: {
    context: Prepared;
    revset: string;
  }) {
    const immutable = yield* run({
      cwd: input.context.cwd,
      args: [
        ...pinned(input.context.operationId),
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

  /** Validates an action against the pinned operation and returns the jj command it runs. */
  const actionCommand = Effect.fn("JjPanelService.actionCommand")(function* (
    action: JjRunActionInput["action"],
    context: Prepared,
  ): Effect.fn.Return<{ args: ReadonlyArray<string>; stdin?: string }, JjPanelError> {
    const files = (
      commitId: string,
      paths: ReadonlyArray<string> | undefined,
      allowUnchanged = false,
    ) =>
      selectedFiles({
        cwd: context.cwd,
        operationId: context.operationId,
        commitId,
        paths,
        allowUnchanged,
      });
    switch (action.type) {
      case "new":
      case "merge": {
        yield* context.targets(action.parentCommitIds, { clean: action.type === "merge" });
        return { args: ["new", "--message", "", "--", ...action.parentCommitIds] };
      }
      case "commit": {
        const wc = yield* context.workingCopy();
        yield* context.targets([wc.commitId], { mutable: true, clean: true });
        return { args: ["commit", "--message", action.description] };
      }
      case "edit": {
        yield* context.targets([action.revisionCommitId], { mutable: true });
        return { args: ["edit", action.revisionCommitId] };
      }
      case "insert": {
        yield* context.targets(action.revisionCommitIds, {
          mutable: action.position === "before",
          clean: true,
        });
        const targets = action.revisionCommitIds.join(" | ");
        yield* guardRewrite({
          context,
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
        if (action.sourceCommitId === action.destinationCommitId)
          return yield* error("invalid-target");
        const [source] = yield* context.targets([action.sourceCommitId], {
          mutable: true,
          clean: true,
        });
        yield* context.targets([action.destinationCommitId], {
          mutable: action.mode === "into",
          clean: true,
        });
        const selected = yield* files(action.sourceCommitId, action.paths);
        const policy = action.messagePolicy;
        const message =
          policy?.type === "replace"
            ? ["--message", policy.description]
            : action.mode === "onto"
              ? ["--message", source?.description ?? ""]
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
            ...selected,
          ],
        };
      }
      case "absorb": {
        yield* context.targets([action.revisionCommitId], { mutable: true, clean: true });
        const selected = yield* files(action.revisionCommitId, action.paths);
        return {
          args: [
            "absorb",
            "--from",
            action.revisionCommitId,
            "--into",
            `ancestors(${action.revisionCommitId}) & mutable() ~ conflicts()`,
            "--",
            ...selected,
          ],
        };
      }
      case "rebase": {
        if (action.destinationCommitIds.includes(action.revisionCommitId))
          return yield* error("invalid-target");
        yield* context.targets([action.revisionCommitId], { mutable: true, clean: true });
        yield* context.targets(action.destinationCommitIds, { clean: true });
        if (action.mode === "branch")
          yield* guardRewrite({ context, revset: `descendants(${action.revisionCommitId})` });
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
        yield* context.targets([action.revisionCommitId], { clean: true });
        if (action.destinationCommitIds)
          yield* context.targets(action.destinationCommitIds, { clean: true });
        return {
          args: [
            "duplicate",
            action.revisionCommitId,
            ...(action.destinationCommitIds ?? []).flatMap((id) => ["--onto", id]),
          ],
        };
      }
      case "abandon": {
        yield* context.targets(action.revisionCommitIds, { mutable: true });
        return { args: ["abandon", "--", ...action.revisionCommitIds] };
      }
      case "restore": {
        yield* context.targets([action.revisionCommitId], { mutable: true });
        const selected = yield* files(action.revisionCommitId, action.paths, true);
        return { args: ["restore", "--changes-in", action.revisionCommitId, "--", ...selected] };
      }
      case "undo":
      case "redo":
        return { args: [action.type] };
      case "bookmark-set":
      case "bookmark-advance": {
        yield* context.targets([action.revisionCommitId], { clean: true });
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
  });

  const runAction = Effect.fn("JjPanelService.runAction")(function* (request: JjRunActionInput) {
    // Service callers (MCP/CLI) have the same validation boundary as RPC callers.
    const decoded = yield* decodeRunAction(request).pipe(
      Effect.mapError(() => error("invalid-target")),
    );
    return yield* mutate({
      request: decoded,
      action: decoded.action.type,
      prepare: (context) => actionCommand(decoded.action, context),
    });
  });

  const getDiff = Effect.fn("JjPanelService.getDiff")(function* (request: JjGetDiffInput) {
    const input = yield* decodeGetDiff(request).pipe(
      Effect.mapError(() => error("invalid-target")),
    );
    const identity = yield* resolve(input.cwd);
    if ("status" in identity) return yield* error("unavailable");
    if (!sameIdentity(identity, input.workspaceIdentity)) return yield* error("workspace-mismatch");
    // Commit ids address content, so reading at the client's operation stays exact while the
    // workspace moves on; nothing here needs a snapshot or the repository lock.
    const operationId = input.expectedOperationId;
    const found = yield* lookupRevisions({
      cwd: input.cwd,
      operationId,
      commitIds: [input.revisionCommitId, ...(input.fromCommitId ? [input.fromCommitId] : [])],
    }).pipe(
      Effect.mapError((cause) =>
        cause.reason === "command-failed" ? error("stale-state") : cause,
      ),
    );
    for (const id of [input.revisionCommitId, input.fromCommitId])
      if (id && !found.some((target) => target.commitId === id))
        return yield* error("invalid-target");
    const selected =
      input.filePath === undefined
        ? []
        : input.fromCommitId
          ? yield* decodeFilePath(input.filePath).pipe(
              Effect.mapBoth({
                onFailure: () => error("invalid-path"),
                onSuccess: (value) => [`root-file:${quote(value)}`],
              }),
            )
          : yield* selectedFiles({
              cwd: input.cwd,
              operationId,
              commitId: input.revisionCommitId,
              paths: [input.filePath],
            });
    const output = yield* process
      .run({
        operation: "JjPanelService.getDiff",
        command: "jj",
        cwd: input.cwd,
        args: [
          "--no-pager",
          "--color=never",
          ...pinned(operationId),
          "diff",
          "--git",
          ...(input.fromCommitId
            ? ["--from", input.fromCommitId, "--to", input.revisionCommitId]
            : ["--revision", input.revisionCommitId]),
          "--",
          ...selected,
        ],
        outputMode: "truncate",
        maxOutputBytes: 1_000_000,
        appendTruncationMarker: false,
      })
      .pipe(Effect.mapError(() => error("command-failed")));
    if (output.stdoutInvalidUtf8) return yield* error("invalid-output");
    return {
      diff: output.stdout,
      operationId,
      commitId: input.revisionCommitId,
      truncated: output.stdoutTruncated,
    } satisfies JjDiffResult;
  });
  const describe = Effect.fn("JjPanelService.describe")((request: JjDescribeInput) =>
    mutate({
      request,
      action: "describe",
      prepare: Effect.fn("JjPanelService.describe.prepare")(function* (context) {
        yield* context.targets([request.revisionCommitId], { mutable: true });
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
      prepare: Effect.fn("JjPanelService.squash.prepare")(function* (context) {
        const [source, destination] = yield* context.targets(
          [request.sourceCommitId, request.destinationCommitId],
          { mutable: true },
        );
        if (!source || !destination) return yield* error("invalid-target");
        if (source.conflict || destination.conflict) return yield* error("conflicted");
        const ancestorOutput = yield* run({
          cwd: context.cwd,
          args: [
            ...pinned(context.operationId),
            "log",
            "--no-graph",
            "-r",
            `${destination.commitId} & ancestors(${source.commitId})`,
            "-T",
            'json(commit_id) ++ "\\n"',
          ],
        });
        const ancestors = yield* Effect.forEach(lines(ancestorOutput), (line) =>
          decode(JjCommitId, line),
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
  return JjPanelService.of({
    getPanel,
    getRevision,
    describe,
    squash,
    revertOperation,
    runAction,
    getDiff,
    currentOperation,
    lookupRevisions,
  });
});
export const layer = Layer.effect(JjPanelService, make).pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
);
