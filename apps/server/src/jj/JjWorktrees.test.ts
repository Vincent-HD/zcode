import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const layer = Layer.mergeAll(GitVcsDriver.layer, VcsProcess.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-worktrees-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-worktrees-" });
  const exec = (command: "git" | "jj", cwd: string, args: ReadonlyArray<string>) =>
    process
      .run({
        operation: "JjWorktrees.test",
        command,
        cwd,
        args:
          command === "jj"
            ? [
                "--no-pager",
                "--config",
                'user.name="Test"',
                "--config",
                'user.email="test@example.invalid"',
                ...args,
              ]
            : ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      })
      .pipe(Effect.map((output) => output.stdout.trim()));
  const workspaces = (cwd: string) =>
    exec("jj", cwd, ["workspace", "list", "-T", 'name ++ "=" ++ root ++ "\\n"']).pipe(
      Effect.map((output) => output.split("\n")),
    );
  return { fs, path, driver, temp, exec, workspaces };
});

describe("JjWorktrees", () => {
  it.live("creates T3 worktrees of a colocated jj repository as jj workspaces", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const repo = f.path.join(f.temp, "repo");
      yield* f.exec("jj", f.temp, ["git", "init", "--colocate", repo]);
      yield* f.fs.writeFileString(f.path.join(repo, "a.txt"), "a\n");
      yield* f.exec("jj", repo, ["commit", "-m", "base"]);
      yield* f.exec("jj", repo, ["bookmark", "set", "main", "-r", "@-"]);
      const base = yield* f.exec("git", repo, ["rev-parse", "main"]);

      const branched = yield* f.driver.createWorktree(
        { cwd: repo, refName: "main", newRefName: "t3/one", path: null },
        { fastCheckout: true },
      );
      const branchedPath = branched.worktree.path;
      assert.isTrue(yield* f.fs.exists(f.path.join(branchedPath, ".jj")));
      assert.equal(yield* f.exec("git", branchedPath, ["branch", "--show-current"]), "t3/one");
      assert.equal(yield* f.fs.readFileString(f.path.join(branchedPath, "a.txt")), "a\n");
      assert.include(yield* f.workspaces(repo), `${f.path.basename(branchedPath)}=${branchedPath}`);

      // A commit-ish other than a local branch checks out detached, as `git worktree add` does.
      const detachedPath = f.path.join(f.temp, "nested", "detached");
      yield* f.driver.createWorktree({ cwd: repo, refName: base, path: detachedPath });
      assert.equal(yield* f.exec("git", detachedPath, ["branch", "--show-current"]), "");
      assert.equal(yield* f.exec("git", detachedPath, ["rev-parse", "HEAD"]), base);

      // Git work done by an agent stays visible to jj.
      yield* f.fs.writeFileString(f.path.join(branchedPath, "b.txt"), "b\n");
      yield* f.exec("git", branchedPath, ["add", "b.txt"]);
      yield* f.exec("git", branchedPath, ["commit", "-m", "agent"]);
      assert.equal(
        yield* f.exec("jj", repo, ["log", "--no-graph", "-r", "t3/one", "-T", "description"]),
        "agent",
      );

      yield* f.driver.removeWorktree({ cwd: repo, path: branchedPath, force: true });
      yield* f.driver.removeWorktree({ cwd: repo, path: detachedPath, force: true });
      assert.isFalse(yield* f.fs.exists(branchedPath));
      assert.deepStrictEqual(yield* f.workspaces(repo), [`default=${repo}`]);
      assert.equal(
        yield* f
          .exec("git", repo, ["worktree", "list", "--porcelain"])
          .pipe(
            Effect.map(
              (output) => output.split("\n").filter((line) => line.startsWith("worktree ")).length,
            ),
          ),
        1,
      );

      // The same branch name maps to the same folder, and a stale record there is replaced.
      yield* f.exec("jj", repo, ["workspace", "add", "--name", "stale", detachedPath]);
      yield* f.fs.remove(detachedPath, { recursive: true });
      yield* f.exec("git", repo, ["worktree", "prune"]);
      yield* f.driver.createWorktree({ cwd: repo, refName: base, path: detachedPath });
      assert.deepStrictEqual(
        (yield* f.workspaces(repo)).toSorted(),
        [`default=${repo}`, `detached=${detachedPath}`].toSorted(),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.live("keeps plain Git worktrees outside jj", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const repo = f.path.join(f.temp, "plain");
      yield* f.exec("git", f.temp, ["init", "--initial-branch=main", repo]);
      yield* f.exec("git", repo, ["commit", "--allow-empty", "-m", "base"]);
      const created = yield* f.driver.createWorktree({
        cwd: repo,
        refName: "main",
        newRefName: "t3/plain",
        path: f.path.join(f.temp, "plain-worktree"),
      });
      assert.isFalse(yield* f.fs.exists(f.path.join(created.worktree.path, ".jj")));
      assert.equal(
        yield* f.exec("git", created.worktree.path, ["branch", "--show-current"]),
        "t3/plain",
      );
    }).pipe(Effect.provide(layer)),
  );
});
