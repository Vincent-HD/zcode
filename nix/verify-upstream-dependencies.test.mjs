import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const verifierPath = fileURLToPath(new URL("./verify-upstream-dependencies.mjs", import.meta.url));
const temporaryDirectories = [];

function writeFile(root, path, contents) {
  const fullPath = join(root, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, contents);
}

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function createFixture({ initializeSourceGit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "z-code-upstream-check-"));
  temporaryDirectories.push(root);
  const source = join(root, "fork");
  const upstream = join(root, "upstream");
  mkdirSync(source);
  mkdirSync(upstream);

  for (const directory of [source, upstream]) {
    writeFile(directory, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFile(directory, "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "packages/*"\n');
    writeFile(directory, "third-party-licenses.config.json", '{"customNotices":[],"packageOverrides":[]}\n');
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
        "    owner = \"spdx\";",
        "    repo = \"license-list-data\";",
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
        "    export SPDX_LICENSE_CACHE_DIRECTORY=\"$spdxLicenseCacheDirectory\"",
        "        const target = path.join(process.env.SPDX_LICENSE_CACHE_DIRECTORY, licenseId + \".json\");",
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
    for (const name of ["client-runtime", "contracts", "provider-cursor", "shared", "ssh", "tailscale"]) {
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
  return spawnSync(process.execPath, [verifierPath, source, upstream, "fixture", sourceMode], {
    encoding: "utf8",
    env,
  });
}

function environmentWithoutGit() {
  const path = mkdtempSync(join(tmpdir(), "z-code-no-git-path-"));
  temporaryDirectories.push(path);
  return { ...process.env, PATH: path };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("upstream packaging compatibility check", () => {
  it("allows the current server, web, and supporting feature source changes", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.source, "apps/server/src/server.ts"), "export const server = 'fork';\n");
    writeFileSync(join(fixture.source, "apps/web/src/main.tsx"), "export const web = 'fork';\n");
    writeFileSync(
      join(fixture.source, "packages/contracts/src/index.ts"),
      "export const featureContracts = true;\n",
    );
    writeFileSync(
      join(fixture.source, "packages/client-runtime/src/index.ts"),
      "export const featureRuntime = true;\n",
    );
    writeFileSync(
      join(fixture.source, "packages/provider-cursor/src/index.ts"),
      "export const featureProviderUsage = true;\n",
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /retained desktop\/native runtime source files match/);
  });

  it("rejects a changed retained desktop source file", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.source, "apps/desktop/src/main.ts"),
      "export const runtime = false;\n",
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retained runtime source apps\/desktop\/src\/main\.ts differs/);
  });

  it("recursively checks a Git-flake snapshot without Git and rejects a retained-source mismatch", () => {
    const fixture = createFixture({ initializeSourceGit: false });
    const env = environmentWithoutGit();
    assert.equal(existsSync(join(fixture.source, ".git")), false);

    const matchingSnapshotResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    assert.equal(matchingSnapshotResult.status, 0, matchingSnapshotResult.stderr);

    writeFileSync(
      join(fixture.source, "apps/desktop/src/main.ts"),
      "export const runtime = 'snapshot mismatch';\n",
    );
    const mismatchedSnapshotResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    assert.notEqual(mismatchedSnapshotResult.status, 0);
    assert.match(
      mismatchedSnapshotResult.stderr,
      /retained runtime source apps\/desktop\/src\/main\.ts differs/,
    );
  });

  it("rejects an unknown source mode", () => {
    const fixture = createFixture();
    const result = verify(fixture.source, fixture.upstream, "unknown-mode");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid source mode 'unknown-mode'.*working-checkout.*git-flake-snapshot/);
  });

  it("ignores ignored install artifacts while still rejecting a changed tracked desktop file", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.upstream, "apps/desktop/empty-upstream-directory"), { recursive: true });
    writeFile(
      fixture.source,
      "apps/desktop/node_modules/native-runtime/index.js",
      "ignored generated dependency\n",
    );
    runGit(fixture.source, ["check-ignore", "-q", "--", "apps/desktop/node_modules/native-runtime/index.js"]);

    const ignoredArtifactResult = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.equal(ignoredArtifactResult.status, 0, ignoredArtifactResult.stderr);

    writeFileSync(
      join(fixture.source, "apps/desktop/src/main.ts"),
      "export const runtime = 'tracked fork edit';\n",
    );
    const trackedEditResult = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(trackedEditResult.status, 0);
    assert.match(trackedEditResult.stderr, /retained runtime source apps\/desktop\/src\/main\.ts differs/);
  });

  it("preserves symlink and executable-file comparisons", () => {
    const fixture = createFixture();
    const launcherPath = "apps/desktop/src/launcher.sh";
    const runtimeLinkPath = "apps/desktop/src/runtime.ts";
    for (const root of [fixture.source, fixture.upstream]) {
      writeFile(root, launcherPath, "#!/bin/sh\nexit 0\n");
      chmodSync(join(root, launcherPath), 0o755);
      symlinkSync("main.ts", join(root, runtimeLinkPath));
    }
    runGit(fixture.source, ["add", "--", launcherPath, runtimeLinkPath]);

    const matchingEntriesResult = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.equal(matchingEntriesResult.status, 0, matchingEntriesResult.stderr);

    chmodSync(join(fixture.source, launcherPath), 0o644);
    const executableMismatchResult = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(executableMismatchResult.status, 0);
    assert.match(executableMismatchResult.stderr, /retained runtime source apps\/desktop\/src\/launcher\.sh differs/);

    chmodSync(join(fixture.source, launcherPath), 0o755);
    unlinkSync(join(fixture.source, runtimeLinkPath));
    symlinkSync("server.ts", join(fixture.source, runtimeLinkPath));
    const symlinkMismatchResult = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(symlinkMismatchResult.status, 0);
    assert.match(symlinkMismatchResult.stderr, /retained runtime source apps\/desktop\/src\/runtime\.ts differs/);
  });

  it("compares symlink targets and executable modes in a Git-flake snapshot", () => {
    const fixture = createFixture({ initializeSourceGit: false });
    const env = environmentWithoutGit();
    const launcherPath = "apps/desktop/src/launcher.sh";
    const runtimeLinkPath = "apps/desktop/src/runtime.ts";
    for (const root of [fixture.source, fixture.upstream]) {
      writeFile(root, launcherPath, "#!/bin/sh\nexit 0\n");
      chmodSync(join(root, launcherPath), 0o755);
      symlinkSync("main.ts", join(root, runtimeLinkPath));
    }

    const matchingEntriesResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    assert.equal(matchingEntriesResult.status, 0, matchingEntriesResult.stderr);

    chmodSync(join(fixture.source, launcherPath), 0o644);
    const executableMismatchResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    assert.notEqual(executableMismatchResult.status, 0);
    assert.match(
      executableMismatchResult.stderr,
      /retained runtime source apps\/desktop\/src\/launcher\.sh differs/,
    );

    chmodSync(join(fixture.source, launcherPath), 0o755);
    unlinkSync(join(fixture.source, runtimeLinkPath));
    symlinkSync("server.ts", join(fixture.source, runtimeLinkPath));
    const symlinkMismatchResult = verify(
      fixture.source,
      fixture.upstream,
      "git-flake-snapshot",
      env,
    );
    assert.notEqual(symlinkMismatchResult.status, 0);
    assert.match(
      symlinkMismatchResult.stderr,
      /retained runtime source apps\/desktop\/src\/runtime\.ts differs/,
    );
  });

  it("rejects a changed retained native helper source file", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.source, "native/resource-monitor/src/main.rs"),
      "fn main() { println!(\"fork\"); }\n",
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retained runtime source native\/resource-monitor\/src\/main\.rs differs/);
  });

  it("rejects an SPDX version that differs from the license generator", () => {
    const fixture = createFixture();
    const nixDefaults = join(fixture.source, "nix/default.nix");
    writeFileSync(
      nixDefaults,
      readFileSync(nixDefaults, "utf8").replace("v3.28.0", "v3.29.0"),
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nix\/default\.nix pins v3\.29\.0.*uses v3\.28\.0/);
  });

  it("rejects an SPDX revision that differs from the license generator", () => {
    const fixture = createFixture();
    const nixDefaults = join(fixture.source, "nix/default.nix");
    const nixSource = readFileSync(nixDefaults, "utf8");
    writeFileSync(
      nixDefaults,
      nixSource.replace("c4a7237ec8f4654e867546f9f409749300f1bf4c", "0000000000000000000000000000000000000000"),
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nix\/default\.nix pins revision 0000000.*uses c4a7237/);
  });

  it("rejects a renderer cache path that stops using the shared SPDX version", () => {
    const fixture = createFixture();
    const rendererFile = join(fixture.source, "nix/renderer-server.nix");
    const rendererSource = readFileSync(rendererFile, "utf8");
    writeFileSync(
      rendererFile,
      rendererSource.replace("${spdxLicenseListVersion}", "v3.29.0"),
    );

    const result = verify(fixture.source, fixture.upstream, "working-checkout");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /renderer-server\.nix must populate the cache directory selected by spdxLicenseListVersion/);
  });
});
