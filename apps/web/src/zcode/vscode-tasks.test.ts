import { describe, expect, it } from "vite-plus/test";

import { packageManagerProbePaths, vscodeTaskScripts } from "./vscode-tasks";

const scripts = (
  contents: string,
  os: "linux" | "darwin" | "windows" = "linux",
  existingPaths: ReadonlySet<string> = new Set(),
) =>
  vscodeTaskScripts({ contents, os, workspaceFolder: "/work/my app", existingPaths }).map(
    (script) => ({
      name: script.name,
      command: script.command,
      icon: script.icon,
    }),
  );

describe("vscodeTaskScripts", () => {
  it("reads JSONC tasks with comments and trailing commas", () => {
    expect(
      scripts(`{
        // See https://go.microsoft.com/fwlink/?LinkId=733558
        "version": "2.0.0",
        "tasks": [
          { "label": "dev", "type": "shell", "command": "pnpm dev", },
          /* block */
          { "label": "unit", "type": "shell", "command": "pnpm test", "group": "test" },
          { "label": "compile", "command": "make", "group": { "kind": "build", "isDefault": true } },
        ],
      }`),
    ).toEqual([
      { name: "dev", command: "pnpm dev", icon: "play" },
      { name: "unit", command: "pnpm test", icon: "test" },
      { name: "compile", command: "make", icon: "build" },
    ]);
  });

  it("quotes args like VS Code and honors explicit quoting", () => {
    expect(
      scripts(`{ "tasks": [
        { "label": "shell", "type": "shell", "command": "echo", "args": ["a b", "plain", "$HOME"] },
        { "label": "quoting", "type": "shell", "command": "echo", "args": [
          { "value": "it's", "quoting": "strong" },
          { "value": "$HOME x", "quoting": "weak" },
          { "value": "a b", "quoting": "escape" }
        ] },
        { "label": "process", "type": "process", "command": "/opt/my tool", "args": ["--flag"] }
      ] }`),
    ).toEqual([
      { name: "shell", command: "echo 'a b' plain $HOME", icon: "play" },
      { name: "quoting", command: `echo 'it'\\''s' "$HOME x" a\\ b`, icon: "play" },
      { name: "process", command: "'/opt/my tool' --flag", icon: "play" },
    ]);
  });

  it("resolves workspace and env variables", () => {
    expect(
      scripts(`{ "tasks": [
        { "label": "vars", "command": "ls", "args": ["\${workspaceFolder}/src", "\${env:TARGET}", "\${userHome}"] },
        { "label": "base", "command": "echo \${workspaceFolderBasename}\${/}x" }
      ] }`),
    ).toEqual([
      { name: "vars", command: `ls '/work/my app/src' "\${TARGET}" "\${HOME}"`, icon: "play" },
      { name: "base", command: "echo my app/x", icon: "play" },
    ]);
  });

  it("applies platform overrides and options in a subshell", () => {
    const contents = `{
      "options": { "env": { "CI": "1" } },
      "tasks": [{
        "label": "open",
        "command": "xdg-open .",
        "osx": { "command": "open ." },
        "options": { "cwd": "\${workspaceFolder}/docs", "env": { "MODE": "it's" } }
      }]
    }`;
    expect(scripts(contents)).toEqual([
      {
        name: "open",
        command: `(cd '/work/my app/docs' && export CI='1' && export MODE='it'\\''s' && xdg-open .)`,
        icon: "play",
      },
    ]);
    expect(scripts(contents, "darwin")[0]?.command).toContain("&& open .)");
    expect(scripts(contents, "windows")).toEqual([]);
  });

  it("runs npm scripts and chains dependsOn", () => {
    expect(
      scripts(`{ "tasks": [
        { "type": "npm", "script": "lint", "path": "web", "icon": { "id": "checklist" } },
        { "label": "a", "command": "echo a", "hide": true },
        { "label": "b", "command": "echo b", "hide": true },
        { "label": "all", "dependsOn": ["a", "b"], "dependsOrder": "sequence", "icon": { "id": "tools" } },
        { "label": "watch", "dependsOn": ["a", "b"], "command": "echo done" }
      ] }`),
    ).toEqual([
      { name: "npm: lint", command: "(cd '/work/my app/web' && npm run 'lint')", icon: "lint" },
      { name: "all", command: "echo a && echo b", icon: "build" },
      { name: "watch", command: "{ (echo a) & (echo b) & wait; } && echo done", icon: "play" },
    ]);
  });

  it("runs npm tasks with the package manager of the nearest lockfile", () => {
    const contents = `{ "tasks": [
      { "type": "npm", "script": "dev", "path": "apps/web/" },
      { "type": "npm", "script": "build" },
      { "label": "shell", "command": "make" }
    ] }`;
    const probes = packageManagerProbePaths({ contents, workspaceFolder: "/work/my app" });
    expect(probes.slice(0, 5)).toEqual([
      "/work/my app/apps/web/bun.lock",
      "/work/my app/apps/web/bun.lockb",
      "/work/my app/apps/web/pnpm-lock.yaml",
      "/work/my app/apps/web/yarn.lock",
      "/work/my app/apps/web/package-lock.json",
    ]);
    expect(probes).toHaveLength(15);
    const commands = (existing: ReadonlyArray<string>) =>
      scripts(contents, "linux", new Set(existing)).map((script) => script.command);
    expect(commands(["/work/my app/pnpm-lock.yaml"])).toEqual([
      "(cd '/work/my app/apps/web/' && pnpm run 'dev')",
      "pnpm run 'build'",
      "make",
    ]);
    expect(
      commands(["/work/my app/pnpm-lock.yaml", "/work/my app/apps/web/bun.lock"])[0],
    ).toContain("&& bun run 'dev'");
    expect(commands([])[1]).toBe("npm run 'build'");
  });

  it("prompts in the terminal for inputs, once per task", () => {
    expect(
      scripts(`{
        "inputs": [
          { "id": "pr", "type": "promptString", "description": "PR number" },
          { "id": "port", "type": "promptString", "description": "Port", "default": "5433" },
          { "id": "env", "type": "pickString", "options": ["dev", { "label": "Prod", "value": "prod" }] }
        ],
        "tasks": [
          { "label": "db", "command": "forward pr-\${input:pr} db \${input:port}", "hide": true },
          { "label": "both", "dependsOn": "db", "command": "echo", "args": ["\${input:pr}", "\${input:env}"] }
        ]
      }`),
    ).toEqual([
      {
        name: "both",
        command:
          "printf '%s: ' 'PR number' && read -r vscode_input_pr" +
          " && printf '%s: ' 'Port [5433]' && read -r vscode_input_port" +
          " && vscode_input_port=${vscode_input_port:-'5433'}" +
          " && printf '%s: ' 'env (dev, prod)' && read -r vscode_input_env" +
          " && forward pr-${vscode_input_pr} db ${vscode_input_port}" +
          ' && echo "${vscode_input_pr}" "${vscode_input_env}"',
        icon: "play",
      },
    ]);
  });

  it("skips tasks it cannot run faithfully and keeps the rest", () => {
    expect(
      scripts(`{ "tasks": [
        { "label": "file", "command": "eslint \${file}" },
        { "label": "input", "command": "deploy \${input:pick}" },
        { "label": "gulp", "type": "gulp", "task": "build" },
        { "label": "cycle", "dependsOn": "cycle" },
        { "label": "missing", "dependsOn": "nope" },
        { "label": "bad", "command": 42 },
        { "command": "no label" },
        { "label": "ok", "command": "true" }
      ] }`),
    ).toEqual([{ name: "ok", command: "true", icon: "play" }]);
    expect(scripts("not json")).toEqual([]);
  });
});
