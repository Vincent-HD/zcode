import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const NULL_OID = "0000000000000000000000000000000000000000";
const DEFAULT_WORKSPACE = "default";
const WorkspaceEntry = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
const decodeWorkspaceEntry = Schema.decodeUnknownOption(WorkspaceEntry);

/**
 * In a colocated jj repository, T3 worktrees become jj workspaces. jj 0.46+ backs each one with a
 * Git worktree, which jj cannot adopt after `git worktree add`, so the checkout itself is swapped.
 * Built from the Git driver's own context so the driver gains no dependency.
 */
export const makeJjWorktrees = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run = Effect.fn("JjWorktrees.run")(function* (input: {
    command: "git" | "jj";
    cwd: string;
    args: ReadonlyArray<string>;
  }) {
    const args =
      input.command === "jj" ? ["--no-pager", "--color=never", ...input.args] : input.args;
    const failure = (detail: string, extra?: { exitCode?: number; cause?: unknown }) =>
      new GitCommandError({
        operation: "JjWorktrees.run",
        command: `${input.command} ${input.args.slice(0, 2).join(" ")}`,
        cwd: input.cwd,
        detail,
        ...extra,
      });
    const env = yield* HostProcess.Environment;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(input.command, args, { cwd: input.cwd, env, extendEnv: false }),
        );
        const text = (stream: typeof child.stdout) => Stream.mkString(Stream.decodeText(stream));
        return yield* Effect.all([text(child.stdout), text(child.stderr), child.exitCode], {
          concurrency: "unbounded",
        });
      }),
    ).pipe(Effect.mapError((cause) => failure(`Failed to run ${input.command}.`, { cause })));
    const [stdout, stderr, exitCode] = result;
    return { stdout, stderr: stderr.trim(), exitCode: Number(exitCode), failure };
  });
  const checked = (input: Parameters<typeof run>[0]) =>
    run(input).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              result.failure(result.stderr || `${input.command} exited with ${result.exitCode}`, {
                exitCode: result.exitCode,
              }),
            ),
      ),
    );

  /** The jj workspace root holding `cwd` when it is colocated with Git, else null. */
  const colocatedRoot = Effect.fn("JjWorktrees.colocatedRoot")(
    function* (cwd: string) {
      let directory = yield* fileSystem.realPath(cwd);
      while (!(yield* fileSystem.exists(path.join(directory, ".jj")))) {
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
      }
      return (yield* fileSystem.exists(path.join(directory, ".git"))) ? directory : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const listWorkspaces = (cwd: string) =>
    checked({
      command: "jj",
      cwd,
      args: [
        "--ignore-working-copy",
        "workspace",
        "list",
        "-T",
        '"[" ++ json(name) ++ "," ++ json(root) ++ "]\n"',
      ],
    }).pipe(
      Effect.map((output) =>
        output
          .split("\n")
          .flatMap((line) => Option.toArray(decodeWorkspaceEntry(line)))
          .map(([name, root]) => ({ name, root: path.resolve(root) })),
      ),
    );
  const forget = (cwd: string, name: string) =>
    checked({
      command: "jj",
      cwd,
      args: ["--ignore-working-copy", "workspace", "forget", "--", name],
    });

  const addWorkspace = Effect.fn("JjWorktrees.addWorkspace")(function* (input: {
    cwd: string;
    worktreePath: string;
    refName: string;
  }) {
    const commit = (yield* checked({
      command: "git",
      cwd: input.cwd,
      args: ["rev-parse", "--verify", "--quiet", `${input.refName}^{commit}`],
    })).trim();
    // Like `git worktree add`, only a bare local branch name is checked out attached.
    const branch =
      (yield* run({
        command: "git",
        cwd: input.cwd,
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
      })).exitCode === 0;
    const target = path.resolve(input.cwd, input.worktreePath);
    const workspaces = yield* listWorkspaces(input.cwd);
    // A workspace recorded at this path lost its folder, since jj and Git both need it empty.
    const stale = workspaces.find(
      (workspace) => workspace.root === target && workspace.name !== DEFAULT_WORKSPACE,
    );
    if (stale) yield* forget(input.cwd, stale.name);
    const taken = new Set(
      workspaces.filter((workspace) => workspace !== stale).map((workspace) => workspace.name),
    );
    const base = path.basename(target);
    let name = base;
    for (let suffix = 2; taken.has(name); suffix++) name = `${base}-${suffix}`;

    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "JjWorktrees.addWorkspace",
            command: "jj workspace add",
            cwd: input.cwd,
            detail: `Could not create ${path.dirname(target)}.`,
            cause,
          }),
      ),
    );
    yield* checked({
      command: "jj",
      cwd: input.cwd,
      args: ["workspace", "add", "--colocate", "--name", name, "--revision", commit, "--", target],
    });
    yield* Effect.gen(function* () {
      if (branch)
        yield* checked({ command: "git", cwd: target, args: ["switch", "--quiet", input.refName] });
      // `git worktree add` runs this hook; jj does not.
      yield* checked({
        command: "git",
        cwd: target,
        args: ["hook", "run", "--ignore-missing", "post-checkout", "--", NULL_OID, commit, "1"],
      });
    }).pipe(
      Effect.onError(() =>
        forget(input.cwd, name).pipe(
          Effect.andThen(fileSystem.remove(target, { recursive: true })),
          Effect.catchCause((cause) =>
            Effect.logWarning("could not remove a partially created jj workspace", {
              target,
              cause,
            }),
          ),
        ),
      ),
    );
  });

  return {
    /** The checkout to run instead of `git worktree add`, or null outside a colocated jj repository. */
    checkout: Effect.fn("JjWorktrees.checkout")(function* (input: {
      cwd: string;
      worktreePath: string;
      refName: string;
    }) {
      return (yield* colocatedRoot(input.cwd)) === null ? null : addWorkspace(input);
    }),
    /** Forgets the jj workspace of a worktree Git just removed, so it leaves the repository's log. */
    forgetRemoved: Effect.fn("JjWorktrees.forgetRemoved")(
      function* (input: { cwd: string; worktreePath: string }) {
        if ((yield* colocatedRoot(input.cwd)) === null) return;
        const target = path.resolve(input.cwd, input.worktreePath);
        for (const workspace of yield* listWorkspaces(input.cwd))
          if (workspace.root === target && workspace.name !== DEFAULT_WORKSPACE)
            yield* forget(input.cwd, workspace.name);
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("could not forget the jj workspace of a removed worktree", { cause }),
      ),
    ),
  };
});
