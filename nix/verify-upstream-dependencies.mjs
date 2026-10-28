import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [sourceRoot, upstreamRoot, version, sourceMode, ...extraArguments] = process.argv.slice(2);

const sourceModes = ["working-checkout", "git-flake-snapshot"];

if (!sourceRoot || !upstreamRoot || !version || !sourceMode || extraArguments.length > 0) {
  throw new Error(
    `Usage: verify-upstream-dependencies.mjs <fork-source> <upstream-source> <version> <source-mode: ${sourceModes.join("|")}>`,
  );
}
if (!sourceModes.includes(sourceMode)) {
  throw new Error(
    `Invalid source mode '${sourceMode}'. Expected one of: ${sourceModes.join(", ")}.`,
  );
}

function readText(root, file) {
  return NodeFS.readFileSync(NodePath.join(root, file), "utf8");
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function workspacePatterns(root) {
  const lines = readText(root, "pnpm-workspace.yaml").split(/\r?\n/);
  const packageSectionIndex = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packageSectionIndex === -1) {
    throw new Error(
      "Cannot validate pnpm workspace manifests: pnpm-workspace.yaml has no packages list.",
    );
  }

  const patterns = [];
  for (const line of lines.slice(packageSectionIndex + 1)) {
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;

    const match = line.match(/^\s*-\s*(.+?)\s*(?:#.*)?$/);
    if (!match?.[1]) {
      throw new Error(
        `Cannot validate pnpm workspace manifests: unsupported packages entry '${line.trim()}'.`,
      );
    }

    const pattern = match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    patterns.push(pattern);
  }

  if (patterns.length === 0) {
    throw new Error(
      "Cannot validate pnpm workspace manifests: pnpm-workspace.yaml has an empty packages list.",
    );
  }
  return patterns;
}

function workspacePackages(root) {
  const paths = new Set(["."]);

  for (const entry of workspacePatterns(root)) {
    const exclude = entry.startsWith("!");
    const pattern = exclude ? entry.slice(1) : entry;
    for (const match of NodeFS.globSync(pattern, { cwd: root })) {
      const normalizedPath = match.split("\\").join("/");
      if (!NodeFS.existsSync(NodePath.join(root, normalizedPath, "package.json"))) continue;
      if (exclude) paths.delete(normalizedPath);
      else paths.add(normalizedPath);
    }
  }

  return new Map(
    [...paths].sort().map((path) => [path, JSON.parse(readText(root, `${path}/package.json`))]),
  );
}

function fail(file, detail) {
  throw new Error(
    `Cannot package fork sources with upstream v${version}: ${file} ${detail}. ` +
      `The AppImage supplies the Electron runtime and native modules, so its dependency graph must match. ` +
      `Rebase the fork onto the intended upstream release and review dependency changes before updating Nix pins.`,
  );
}

function failRetainedRuntimeSource(file, detail) {
  throw new Error(
    `Cannot package fork sources with upstream v${version}: retained runtime source ${file} ${detail}. ` +
      `The Nix package replaces only apps/server/dist; the desktop and native runtime remain from the upstream AppImage. ` +
      `Rebase onto the intended release and review the runtime change before updating Nix pins.`,
  );
}

function failSpdxPins(detail) {
  throw new Error(
    `Cannot generate third-party license notices offline: ${detail}. ` +
      `Keep the SPDX version and revision in nix/default.nix synchronized with scripts/lib/third-party-licenses.ts.`,
  );
}

function readStringAssignment(source, name, file) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[\\t ]*${escapedName}[\\t ]*=[\\t ]*"([^"\\r\\n]+)";[\\t ]*$`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    failSpdxPins(
      `expected exactly one ${name} string assignment in ${file}, found ${matches.length}`,
    );
  }
  return matches[0][1];
}

function readGeneratorConstant(source, name) {
  const pattern = new RegExp(`^const[\\t ]+${name}[\\t ]*=[\\t ]*"([^"\\r\\n]+)";[\\t ]*$`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    failSpdxPins(
      `expected exactly one ${name} constant in scripts/lib/third-party-licenses.ts, found ${matches.length}`,
    );
  }
  return matches[0][1];
}

function verifySpdxPins() {
  const generator = readText(sourceRoot, "scripts/lib/third-party-licenses.ts");
  const nixDefaults = readText(sourceRoot, "nix/default.nix");
  const nixRenderer = readText(sourceRoot, "nix/renderer-server.nix");
  const generatorVersion = readGeneratorConstant(generator, "SPDX_LICENSE_LIST_VERSION");
  const generatorRevision = readGeneratorConstant(generator, "SPDX_LICENSE_LIST_REVISION");
  const nixVersion = readStringAssignment(nixDefaults, "spdxLicenseListVersion", "nix/default.nix");
  const nixRevision = readStringAssignment(
    nixDefaults,
    "spdxLicenseListRevision",
    "nix/default.nix",
  );
  const licenseSourceDefinitions = [
    ...nixDefaults.matchAll(/spdxLicenseList\s*=\s*pkgs\.fetchFromGitHub\s*\{([\s\S]*?)\n\s*\};/g),
  ];

  if (
    licenseSourceDefinitions.length !== 1 ||
    !/^\s*rev\s*=\s*spdxLicenseListRevision;\s*$/m.test(licenseSourceDefinitions[0][1])
  ) {
    failSpdxPins("nix/default.nix must fetch license-list-data from spdxLicenseListRevision");
  }
  if (
    !nixRenderer.includes(
      'spdxLicenseCacheDirectory=".generated/third-party-licenses/spdx/${spdxLicenseListVersion}"',
    ) ||
    !nixRenderer.includes("process.env.SPDX_LICENSE_CACHE_DIRECTORY")
  ) {
    failSpdxPins(
      "nix/renderer-server.nix must populate the cache directory selected by spdxLicenseListVersion",
    );
  }

  if (nixVersion !== generatorVersion) {
    failSpdxPins(
      `nix/default.nix pins ${nixVersion}, but scripts/lib/third-party-licenses.ts uses ${generatorVersion}`,
    );
  }
  if (nixRevision !== generatorRevision) {
    failSpdxPins(
      `nix/default.nix pins revision ${nixRevision}, but scripts/lib/third-party-licenses.ts uses ${generatorRevision}`,
    );
  }
}

function collectTreeEntries(root, tree) {
  const entries = new Map();

  function visit(absolutePath, relativePath) {
    let stat;
    try {
      stat = NodeFS.lstatSync(absolutePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }

    if (stat.isDirectory()) {
      for (const child of NodeFS.readdirSync(absolutePath).sort()) {
        visit(
          NodePath.join(absolutePath, child),
          relativePath === "" ? child : `${relativePath}/${child}`,
        );
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.set(relativePath, { kind: "symlink", value: NodeFS.readlinkSync(absolutePath) });
      return;
    }
    if (stat.isFile()) {
      entries.set(relativePath, {
        kind: "file",
        executable: Boolean(stat.mode & 0o111),
        value: NodeFS.readFileSync(absolutePath),
      });
      return;
    }
    entries.set(relativePath, { kind: "other", value: String(stat.mode) });
  }

  visit(NodePath.join(root, tree), "");
  return entries;
}

function collectWorkingCheckoutTreeEntries(root, tree) {
  const result = NodeChildProcess.spawnSync("git", ["ls-files", "--cached", "-z", "--", tree], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Could not list Git-flake source files under ${root}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not list Git-flake source files under ${root}: ${result.stderr.toString("utf8").trim() || `git exited with ${String(result.status)}`}`,
    );
  }

  const entries = new Map();
  const prefix = `${tree}/`;
  for (const trackedPath of result.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const relativePath = trackedPath.startsWith(prefix)
      ? trackedPath.slice(prefix.length)
      : trackedPath === tree
        ? ""
        : null;
    if (relativePath === null) continue;

    const absolutePath = NodePath.join(root, trackedPath);
    let stat;
    try {
      stat = NodeFS.lstatSync(absolutePath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        continue;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      entries.set(relativePath, { kind: "symlink", value: NodeFS.readlinkSync(absolutePath) });
    } else if (stat.isFile()) {
      entries.set(relativePath, {
        kind: "file",
        executable: Boolean(stat.mode & 0o111),
        value: NodeFS.readFileSync(absolutePath),
      });
    } else if (stat.isDirectory()) {
      entries.set(relativePath, { kind: "directory", value: "directory" });
    } else {
      entries.set(relativePath, { kind: "other", value: String(stat.mode) });
    }
  }

  return entries;
}

function collectSourceTreeEntries(root, tree) {
  switch (sourceMode) {
    case "working-checkout":
      return collectWorkingCheckoutTreeEntries(root, tree);
    case "git-flake-snapshot":
      // Git flakes already omit ignored and untracked files, and store snapshots have no .git.
      return collectTreeEntries(root, tree);
    default:
      throw new Error(`Invalid source mode '${sourceMode}'.`);
  }
}

function sameTreeEntry(left, right) {
  return (
    left.kind === right.kind &&
    left.executable === right.executable &&
    (Buffer.isBuffer(left.value) && Buffer.isBuffer(right.value)
      ? left.value.equals(right.value)
      : left.value === right.value)
  );
}

function verifyRetainedRuntimeSource() {
  // These source trees feed the Electron shell or native helpers kept from the AppImage.
  // apps/server and apps/web are rebuilt from this checkout by nix/renderer-server.nix.
  const retainedRuntimeTrees = [
    "apps/desktop",
    "native",
    "packages/shared",
    "packages/ssh",
    "packages/tailscale",
  ];
  let comparedFiles = 0;

  for (const tree of retainedRuntimeTrees) {
    const sourceEntries = collectSourceTreeEntries(sourceRoot, tree);
    const upstreamEntries = collectTreeEntries(upstreamRoot, tree);
    const paths = [...new Set([...sourceEntries.keys(), ...upstreamEntries.keys()])].sort();
    for (const path of paths) {
      const sourceEntry = sourceEntries.get(path);
      const upstreamEntry = upstreamEntries.get(path);
      const displayPath = path.length === 0 ? tree : `${tree}/${path}`;
      if (!sourceEntry) failRetainedRuntimeSource(displayPath, "is missing from the fork");
      if (!upstreamEntry) failRetainedRuntimeSource(displayPath, "is added by the fork");
      if (!sameTreeEntry(sourceEntry, upstreamEntry)) {
        failRetainedRuntimeSource(displayPath, "differs from the matching pinned upstream source");
      }
      if (sourceEntry.kind === "file") comparedFiles += 1;
    }
  }

  return comparedFiles;
}

for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "third-party-licenses.config.json"]) {
  if (readText(sourceRoot, file) !== readText(upstreamRoot, file)) {
    fail(file, "differs from the matching pinned upstream source");
  }
}

verifySpdxPins();
const retainedRuntimeSourceFiles = verifyRetainedRuntimeSource();

const sourceWorkspaces = workspacePackages(sourceRoot);
const upstreamWorkspaces = workspacePackages(upstreamRoot);
const sourcePaths = [...sourceWorkspaces.keys()].sort();
const upstreamPaths = [...upstreamWorkspaces.keys()].sort();

if (JSON.stringify(sourcePaths) !== JSON.stringify(upstreamPaths)) {
  const missingFromFork = upstreamPaths.filter((path) => !sourceWorkspaces.has(path));
  const missingFromUpstream = sourcePaths.filter((path) => !upstreamWorkspaces.has(path));
  const differences = [
    ...(missingFromFork.length > 0 ? [`missing from fork: ${missingFromFork.join(", ")}`] : []),
    ...(missingFromUpstream.length > 0
      ? [`missing from upstream: ${missingFromUpstream.join(", ")}`]
      : []),
  ];
  fail("pnpm workspace manifests", `cover different packages (${differences.join("; ")})`);
}

const dependencyFields = [
  "name",
  "version",
  "packageManager",
  "engines",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "pnpm",
];

for (const path of sourcePaths) {
  const sourceManifest = sourceWorkspaces.get(path);
  const upstreamManifest = upstreamWorkspaces.get(path);
  const differences = dependencyFields.filter(
    (field) =>
      JSON.stringify(normalize(sourceManifest[field])) !==
      JSON.stringify(normalize(upstreamManifest[field])),
  );

  if (differences.length > 0) {
    fail(`${path}/package.json`, `differs in dependency fields: ${differences.join(", ")}`);
  }
}

console.log(
  `Upstream v${version} compatibility check passed: ${sourcePaths.length} workspace manifests, the lockfile, workspace and license configuration, SPDX generator pins, and ${retainedRuntimeSourceFiles} retained desktop/native runtime source files match.`,
);
