import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

const verifierPath = NodeURL.fileURLToPath(
  new URL("./verify-upstream-dependencies.mjs", import.meta.url),
);
const temporaryDirectories = [];

function writeFile(root, path, contents) {
  const fullPath = NodePath.join(root, path);
  NodeFS.mkdirSync(NodePath.join(fullPath, ".."), { recursive: true });
  NodeFS.writeFileSync(fullPath, contents);
}

function runGit(root, args) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
  NodeAssert.equal(result.status, 0, result.stderr);
}

function createFixture({ initializeSourceGit = true } = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "z-code-upstream-check-"));
  temporaryDirectories.push(root);
  const source = NodePath.join(root, "fork");
  const upstream = NodePath.join(root, "upstream");
  NodeFS.mkdirSync(source);
  NodeFS.mkdirSync(upstream);

  for (const directory of [source, upstream]) {
    writeFile(directory, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFile(directory, "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "packages/*"\n');
    writeFile(
      directory,
      "third-party-licenses.config.json",
      '{"customNotices":[],"packageOverrides":[]}\n',
    );
    writeFile(
      directory,
      "package.json",
      '{"name":"fixture-root","packageManager":"pnpm@11.0.0"}\n',
    );
    writeFile(
      directory,
      "scripts/lib/third-party-licenses.ts",
      [
        'const SPDX_LICENSE_LIST_VERSION = "v3.28.0";',
        'const SPDX_LICENSE_LIST_REVISION = "c4a7237ec8f4654e867546f9f409749300f1bf4c";',
        "",
      ].join("\n"),
    );
    writeFile(
      directory,
      "nix/default.nix",
      [
        '  spdxLicenseListVersion = "v3.28.0";',
        '  spdxLicenseListRevision = "c4a7237ec8f4654e867546f9f409749300f1bf4c";',
        "  spdxLicenseList = pkgs.fetchFromGitHub {",
        '    owner = "spdx";',
        '    repo = "license-list-data";',
        "    rev = spdxLicenseListRevision;",
        "  };",
        "",
      ].join("\n"),
    );
    writeFile(
      directory,
      "nix/renderer-server.nix",
      [
        '    spdxLicenseCacheDirectory=".generated/third-party-licenses/spdx/${spdxLicenseListVersion}"',
        '    export SPDX_LICENSE_CACHE_DIRECTORY="$spdxLicenseCacheDirectory"',
        '        const target = path.join(process.env.SPDX_LICENSE_CACHE_DIRECTORY, licenseId + ".json");',
        "",
      ].join("\n"),
    );

    for (const app of ["desktop", "server", "web"]) {
      writeFile(
        directory,
        `apps/${app}/package.json`,
        JSON.stringify({ name: `fixture-${app}`, version: "1.0.0", dependencies: {} }) + "\n",
      );
    }
    for (const name of [
      "client-runtime",
      "contracts",
      "provider-cursor",
      "shared",
      "ssh",
      "tailscale",
    ]) {
      writeFile(
        directory,
        `packages/${name}/package.json`,
        JSON.stringify({ name: `fixture-${name}`, version: "1.0.0", dependencies: {} }) + "\n",
      );
      writeFile(directory, `packages/${name}/src/index.ts`, `export const name = "${name}";\n`);
    }
    writeFile(directory, "apps/desktop/src/main.ts", "export const runtime = true;\n");
    writeFile(directory, "apps/server/src/server.ts", "export const server = true;\n");
    writeFile(directory, "apps/web/src/main.tsx", "export const web = true;\n");
    writeFile(directory, "native/resource-monitor/src/main.rs", "fn main() {}\n");
  }

  if (initializeSourceGit) {
    writeFile(source, ".gitignore", "node_modules/\n");
    runGit(source, ["init", "--quiet"]);
    runGit(source, ["add", "--all"]);
  }

  return { source, upstream };
}

function verify(source, upstream, sourceMode, env = process.env) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [verifierPath, source, upstream, "fixture", sourceMode],
    {
      encoding: "utf8",
      env,
    },
  );
}

function environmentWithoutGit() {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "z-code-no-git-path-"));
  temporaryDirectories.push(path);
  return { ...process.env, PATH: path };
}

NodeTest.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

NodeTest.describe("upstream packaging compatibility check", () => {
  NodeTest.it("allows the current server, web, and supporting feature source changes", () => {
    const fixture = createFixture();
    NodeFS.writeFileSync(
      NodePath.join(fixture.source, "apps/server/src/server.ts"),
      "export const server = 'fork';\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(fixture.source, "apps/web/src/main.tsx"),
      "export const web = 'fork';\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(fixture.source, "packages/contracts/src/index.ts"),
      "export const featureContracts = true;\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(fixture.source, "packages/client-runtime/src/index.ts"),
      "export const featureRuntime = true;\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(fixture.source, "packages/provider-cursor/src/index.ts"),
      "export const featureProviderUsage = true;\n",
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.match(result.stdout, /retained desktop\/native runtime source files match/);
  });

  NodeTest.it("rejects a changed retained desktop source file", () => {
    const fixture = createFixture();
    NodeFS.writeFileSync(
      NodePath.join(fixture.source, "apps/desktop/src/main.ts"),
      "export const runtime = false;\n",
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(result.stderr, /retained runtime source apps\/desktop\/src\/main\.ts differs/);
  });

  NodeTest.it(
    "recursively checks a Git-flake snapshot without Git and rejects a retained-source mismatch",
    () => {
      const fixture = createFixture({ initializeSourceGit: false });
      const env = environmentWithoutGit();
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(fixture.source, ".git")), false);

      const matchingSnapshotResult = verify(
        fixture.source,
        fixture.upstream,
        "git-flake-snapshot",
        env,
      );
      NodeAssert.equal(matchingSnapshotResult.status, 0, matchingSnapshotResult.stderr);

      NodeFS.writeFileSync(
        NodePath.join(fixture.source, "apps/desktop/src/main.ts"),
        "export const runtime = 'snapshot mismatch';\n",
      );
      const mismatchedSnapshotResult = verify(
        fixture.source,
        fixture.upstream,
        "git-flake-snapshot",
        env,
      );
      NodeAssert.notEqual(mismatchedSnapshotResult.status, 0);
      NodeAssert.match(
        mismatchedSnapshotResult.stderr,
        /retained runtime source apps\/desktop\/src\/main\.ts differs/,
      );
    },
  );

  NodeTest.it("rejects an unknown source mode", () => {
    const fixture = createFixture();
    const result = verify(fixture.source, fixture.upstream, "unknown-mode");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(
      result.stderr,
      /Invalid source mode 'unknown-mode'.*working-checkout.*git-flake-snapshot/,
    );
  });

  NodeTest.it(
    "ignores ignored install artifacts while still rejecting a changed tracked desktop file",
    () => {
      const fixture = createFixture();
      NodeFS.mkdirSync(NodePath.join(fixture.upstream, "apps/desktop/empty-upstream-directory"), {
        recursive: true,
      });
      writeFile(
        fixture.source,
        "apps/desktop/node_modules/native-runtime/index.js",
        "ignored generated dependency\n",
      );
      runGit(fixture.source, [
        "check-ignore",
        "-q",
        "--",
        "apps/desktop/node_modules/native-runtime/index.js",
      ]);

      const ignoredArtifactResult = verify(fixture.source, fixture.upstream, "working-checkout");
      NodeAssert.equal(ignoredArtifactResult.status, 0, ignoredArtifactResult.stderr);

      NodeFS.writeFileSync(
        NodePath.join(fixture.source, "apps/desktop/src/main.ts"),
        "export const runtime = 'tracked fork edit';\n",
      );
      const trackedEditResult = verify(fixture.source, fixture.upstream, "working-checkout");
      NodeAssert.notEqual(trackedEditResult.status, 0);
      NodeAssert.match(
        trackedEditResult.stderr,
        /retained runtime source apps\/desktop\/src\/main\.ts differs/,
      );
    },
  );

  NodeTest.it("preserves symlink and executable-file comparisons", () => {
    const fixture = createFixture();
    const launcherPath = "apps/desktop/src/launcher.sh";
    const runtimeLinkPath = "apps/desktop/src/runtime.ts";
    for (const root of [fixture.source, fixture.upstream]) {
      writeFile(root, launcherPath, "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(NodePath.join(root, launcherPath), 0o755);
      NodeFS.symlinkSync("main.ts", NodePath.join(root, runtimeLinkPath));
    }
    runGit(fixture.source, ["add", "--", launcherPath, runtimeLinkPath]);

    const matchingEntriesResult = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.equal(matchingEntriesResult.status, 0, matchingEntriesResult.stderr);

    NodeFS.chmodSync(NodePath.join(fixture.source, launcherPath), 0o644);
    const executableMismatchResult = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.notEqual(executableMismatchResult.status, 0);
    NodeAssert.match(
      executableMismatchResult.stderr,
      /retained runtime source apps\/desktop\/src\/launcher\.sh differs/,
    );

    NodeFS.chmodSync(NodePath.join(fixture.source, launcherPath), 0o755);
    NodeFS.unlinkSync(NodePath.join(fixture.source, runtimeLinkPath));
    NodeFS.symlinkSync("server.ts", NodePath.join(fixture.source, runtimeLinkPath));
    const symlinkMismatchResult = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.notEqual(symlinkMismatchResult.status, 0);
    NodeAssert.match(
      symlinkMismatchResult.stderr,
      /retained runtime source apps\/desktop\/src\/runtime\.ts differs/,
    );
  });

  NodeTest.it("compares symlink targets and executable modes in a Git-flake snapshot", () => {
    const fixture = createFixture({ initializeSourceGit: false });
    const env = environmentWithoutGit();
    const launcherPath = "apps/desktop/src/launcher.sh";
    const runtimeLinkPath = "apps/desktop/src/runtime.ts";
    for (const root of [fixture.source, fixture.upstream]) {
      writeFile(root, launcherPath, "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(NodePath.join(root, launcherPath), 0o755);
      NodeFS.symlinkSync("main.ts", NodePath.join(root, runtimeLinkPath));
    }

    const matchingEntriesResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    NodeAssert.equal(matchingEntriesResult.status, 0, matchingEntriesResult.stderr);

    NodeFS.chmodSync(NodePath.join(fixture.source, launcherPath), 0o644);
    const executableMismatchResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    NodeAssert.notEqual(executableMismatchResult.status, 0);
    NodeAssert.match(
      executableMismatchResult.stderr,
      /retained runtime source apps\/desktop\/src\/launcher\.sh differs/,
    );

    NodeFS.chmodSync(NodePath.join(fixture.source, launcherPath), 0o755);
    NodeFS.unlinkSync(NodePath.join(fixture.source, runtimeLinkPath));
    NodeFS.symlinkSync("server.ts", NodePath.join(fixture.source, runtimeLinkPath));
    const symlinkMismatchResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    NodeAssert.notEqual(symlinkMismatchResult.status, 0);
    NodeAssert.match(
      symlinkMismatchResult.stderr,
      /retained runtime source apps\/desktop\/src\/runtime\.ts differs/,
    );
  });

  NodeTest.it("rejects a changed retained native helper source file", () => {
    const fixture = createFixture();
    NodeFS.writeFileSync(
      NodePath.join(fixture.source, "native/resource-monitor/src/main.rs"),
      'fn main() { println!("fork"); }\n',
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(
      result.stderr,
      /retained runtime source native\/resource-monitor\/src\/main\.rs differs/,
    );
  });

  NodeTest.it("rejects an SPDX version that differs from the license generator", () => {
    const fixture = createFixture();
    const nixDefaults = NodePath.join(fixture.source, "nix/default.nix");
    NodeFS.writeFileSync(
      nixDefaults,
      NodeFS.readFileSync(nixDefaults, "utf8").replace("v3.28.0", "v3.29.0"),
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(result.stderr, /nix\/default\.nix pins v3\.29\.0.*uses v3\.28\.0/);
  });

  NodeTest.it("rejects an SPDX revision that differs from the license generator", () => {
    const fixture = createFixture();
    const nixDefaults = NodePath.join(fixture.source, "nix/default.nix");
    const nixSource = NodeFS.readFileSync(nixDefaults, "utf8");
    NodeFS.writeFileSync(
      nixDefaults,
      nixSource.replace(
        "c4a7237ec8f4654e867546f9f409749300f1bf4c",
        "0000000000000000000000000000000000000000",
      ),
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(result.stderr, /nix\/default\.nix pins revision 0000000.*uses c4a7237/);
  });

  NodeTest.it("rejects a renderer cache path that stops using the shared SPDX version", () => {
    const fixture = createFixture();
    const rendererFile = NodePath.join(fixture.source, "nix/renderer-server.nix");
    const rendererSource = NodeFS.readFileSync(rendererFile, "utf8");
    NodeFS.writeFileSync(
      rendererFile,
      rendererSource.replace("${spdxLicenseListVersion}", "v3.29.0"),
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(
      result.stderr,
      /renderer-server\.nix must populate the cache directory selected by spdxLicenseListVersion/,
    );
  });
});
