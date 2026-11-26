import type {
  ExecutionEnvironmentPlatformOs,
  ProjectScript,
  ProjectScriptIcon,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const VSCODE_TASKS_FILE = ".vscode/tasks.json";

const SCRIPT_ID_PREFIX = "vscode-task:";

export const isVscodeTaskScriptId = (scriptId: string) => scriptId.startsWith(SCRIPT_ID_PREFIX);

const Quoting = Schema.Literals(["escape", "strong", "weak"]);
const QuotedString = Schema.Struct({
  value: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  quoting: Schema.optional(Quoting),
});
const CommandValue = Schema.Union([Schema.String, QuotedString]);
const ArgValue = Schema.Union([Schema.String, QuotedString]);

const Options = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const Runnable = Schema.Struct({
  type: Schema.optional(Schema.String),
  command: Schema.optional(CommandValue),
  args: Schema.optional(Schema.Array(ArgValue)),
  options: Schema.optional(Options),
});
type Runnable = typeof Runnable.Type;

const DependsOnLabel = Schema.Union([
  Schema.String,
  Schema.Struct({ label: Schema.optional(Schema.String) }),
]);

const Task = Schema.Struct({
  ...Runnable.fields,
  label: Schema.optional(Schema.String),
  script: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  hide: Schema.optional(Schema.Boolean),
  icon: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String) })),
  group: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ kind: Schema.optional(Schema.String) })]),
  ),
  dependsOn: Schema.optional(Schema.Union([DependsOnLabel, Schema.Array(DependsOnLabel)])),
  dependsOrder: Schema.optional(Schema.String),
  windows: Schema.optional(Runnable),
  osx: Schema.optional(Runnable),
  linux: Schema.optional(Runnable),
});
type Task = typeof Task.Type;

// Tasks decode one by one so a single unsupported entry does not hide the rest.
const TasksFile = fromLenientJson(
  Schema.Struct({
    ...Runnable.fields,
    tasks: Schema.optional(Schema.Array(Schema.Unknown)),
    windows: Schema.optional(Runnable),
    osx: Schema.optional(Runnable),
    linux: Schema.optional(Runnable),
  }),
);
type TasksFile = typeof TasksFile.Type;

const decodeTasksFile = Schema.decodeUnknownExit(TasksFile);
const decodeTask = Schema.decodeUnknownExit(Task);

type Segment = { readonly literal: string } | { readonly env: string };

interface Context {
  readonly workspaceFolder: string;
  /** Lockfile paths known to exist, from `packageManagerProbePaths`. */
  readonly existingPaths: ReadonlySet<string>;
}

// Nearest folder wins; within one folder, the first match (same order as preferred-pm).
const LOCKFILES = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
] as const;

/** Lockfile candidates for an npm task, from its `path` folder up to the workspace root. */
const lockfileCandidates = (task: Task, workspaceFolder: string) => {
  const parts = (task.path ?? "").split("/").filter((part) => part !== "" && part !== ".");
  return parts
    .map((_, index) => [workspaceFolder, ...parts.slice(0, parts.length - index)].join("/"))
    .concat(workspaceFolder)
    .map((folder) => LOCKFILES.map(([file, manager]) => ({ path: `${folder}/${file}`, manager })));
};

const packageManager = (task: Task, context: Context) =>
  lockfileCandidates(task, context.workspaceFolder)
    .flat()
    .find((candidate) => context.existingPaths.has(candidate.path))?.manager ?? "npm";

class UnsupportedTask extends Schema.TaggedError<UnsupportedTask>()("UnsupportedTask", {
  reason: Schema.String,
}) {}

const isUnsupportedTask = Schema.is(UnsupportedTask);

const VARIABLE = /\$\{([^}]+)\}/g;

const resolveVariables = (text: string, context: Context): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = [];
  const push = (segment: Segment) => {
    const previous = segments.at(-1);
    if (!("literal" in segment)) segments.push(segment);
    else if (previous !== undefined && "literal" in previous) {
      segments[segments.length - 1] = { literal: previous.literal + segment.literal };
    } else if (segment.literal !== "") segments.push(segment);
  };
  let last = 0;
  for (const match of text.matchAll(VARIABLE)) {
    const name = match[1] ?? "";
    push({ literal: text.slice(last, match.index) });
    last = match.index + match[0].length;
    if (name.startsWith("env:")) {
      push({ env: name.slice("env:".length) });
      continue;
    }
    switch (name) {
      case "workspaceFolder":
      case "workspaceRoot":
      case "cwd":
        push({ literal: context.workspaceFolder });
        break;
      case "workspaceFolderBasename":
        push({ literal: context.workspaceFolder.split("/").findLast(Boolean) ?? "" });
        break;
      case "userHome":
        push({ env: "HOME" });
        break;
      case "pathSeparator":
      case "/":
        push({ literal: "/" });
        break;
      default:
        // Editor state (${file}), prompts (${input:…}) and settings have no T3 equivalent.
        throw new UnsupportedTask({ reason: name });
    }
  }
  push({ literal: text.slice(last) });
  return segments;
};

const envName = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UnsupportedTask({ reason: name });
  return name;
};

const envReference = (name: string) => `\${${envName(name)}}`;

const strongQuote = (literal: string) => `'${literal.replaceAll("'", `'\\''`)}'`;

const quoteSegments = (
  segments: ReadonlyArray<Segment>,
  quoting: typeof Quoting.Type | "raw",
): string =>
  segments
    .map((segment) => {
      if ("env" in segment) {
        const reference = envReference(segment.env);
        return quoting === "raw" ? reference : `"${reference}"`;
      }
      switch (quoting) {
        case "raw":
          return segment.literal;
        case "strong":
          return strongQuote(segment.literal);
        case "weak":
          return `"${segment.literal.replaceAll(/(["\\])/g, "\\$1")}"`;
        case "escape":
          return segment.literal.replaceAll(/([^A-Za-z0-9_\-.,:/@%+=])/g, "\\$1");
      }
    })
    .join("");

// Resolved values may hold spaces, so env references count as needing quotes too.
const needsQuotes = (segments: ReadonlyArray<Segment>) =>
  segments.some((segment) => !("literal" in segment) || /\s/.test(segment.literal));

const commandText = (
  value: typeof CommandValue.Type | typeof ArgValue.Type,
  context: Context,
  defaultQuoting: "raw" | "auto",
): string => {
  const text = typeof value === "string" ? value : [value.value].flat().join(" ");
  const segments = resolveVariables(text, context);
  if (typeof value !== "string" && value.quoting) return quoteSegments(segments, value.quoting);
  if (defaultQuoting === "auto" && needsQuotes(segments)) return quoteSegments(segments, "strong");
  return quoteSegments(segments, "raw");
};

const mergeRunnable = (...layers: ReadonlyArray<Runnable | undefined>): Runnable => {
  const defined = layers.filter((layer) => layer !== undefined);
  const last = <K extends keyof Runnable>(key: K) =>
    defined.findLast((layer) => layer[key] !== undefined)?.[key];
  return {
    type: last("type"),
    command: last("command"),
    args: last("args"),
    options: {
      cwd: defined.findLast((layer) => layer.options?.cwd !== undefined)?.options?.cwd,
      env: Object.assign({}, ...defined.map((layer) => layer.options?.env)),
    },
  };
};

const platformKey = (os: ExecutionEnvironmentPlatformOs) => (os === "darwin" ? "osx" : "linux");

const ownCommand = (
  task: Task,
  file: TasksFile,
  os: ExecutionEnvironmentPlatformOs,
  context: Context,
) => {
  const key = platformKey(os);
  const fileOptions = mergeRunnable({ options: file.options }, { options: file[key]?.options });
  const runnable = mergeRunnable({ type: file.type }, fileOptions, task, task[key]);
  const type = runnable.type ?? "shell";
  let options = runnable.options;
  let command: string | null;
  if (type === "npm") {
    if (task.script === undefined) throw new UnsupportedTask({ reason: "npm task without script" });
    command = `${packageManager(task, context)} run ${strongQuote(task.script)}`;
    if (task.path !== undefined) {
      options = { ...options, cwd: `\${workspaceFolder}/${task.path}` };
    }
  } else if (type === "shell" || type === "process") {
    if (runnable.command === undefined) {
      command = null;
    } else {
      const args = (runnable.args ?? []).map((arg) => commandText(arg, context, "auto"));
      const head = commandText(
        runnable.command,
        context,
        type === "process" || args.length > 0 ? "auto" : "raw",
      );
      command = [head, ...args].join(" ");
    }
  } else {
    // Extension-provided types (gulp, typescript, cargo…) need the extension to resolve.
    throw new UnsupportedTask({ reason: type });
  }
  if (command === null) return null;

  const prelude = [
    ...(options?.cwd === undefined
      ? []
      : [`cd ${quoteSegments(resolveVariables(options.cwd, context), "strong")}`]),
    ...Object.entries(options?.env ?? {}).map(
      ([name, value]) =>
        `export ${envName(name)}=${quoteSegments(resolveVariables(value, context), "strong")}`,
    ),
  ];
  return prelude.length === 0 ? command : `(${[...prelude, command].join(" && ")})`;
};

const dependencyLabels = (task: Task): ReadonlyArray<string> =>
  [task.dependsOn ?? []].flat().map((entry) => {
    const label = typeof entry === "string" ? entry : entry.label;
    if (label === undefined) throw new UnsupportedTask({ reason: "dependsOn without label" });
    return label;
  });

const taskLabel = (task: Task) =>
  task.label ?? (task.type === "npm" && task.script ? `npm: ${task.script}` : undefined);

const ICON_BY_CODICON: ReadonlyArray<readonly [RegExp, ProjectScriptIcon]> = [
  [/^(beaker|testing-|test)/, "test"],
  [/^(debug|bug)/, "debug"],
  [/^(tools|package|archive|symbol-constructor)/, "build"],
  [/^(gear|settings|wrench)/, "configure"],
  [/^(check|checklist|pass|lightbulb)/, "lint"],
];

const taskIcon = (task: Task): ProjectScriptIcon => {
  const codicon = task.icon?.id;
  const fromCodicon =
    codicon === undefined
      ? undefined
      : ICON_BY_CODICON.find(([pattern]) => pattern.test(codicon))?.[1];
  if (fromCodicon) return fromCodicon;
  const group = typeof task.group === "string" ? task.group : task.group?.kind;
  if (group === "build" || group === "test") return group;
  return "play";
};

/** Turns a `.vscode/tasks.json` into runnable T3 scripts for a POSIX shell. */
const decodeTasks = (contents: string) => {
  const decoded = decodeTasksFile(contents);
  if (Exit.isFailure(decoded)) return null;
  const tasks = (decoded.value.tasks ?? []).flatMap((raw) => {
    const task = decodeTask(raw);
    return Exit.isSuccess(task) ? [task.value] : [];
  });
  return { file: decoded.value, tasks };
};

/** Absolute paths whose existence picks the package manager of each npm task. */
export const packageManagerProbePaths = (input: {
  readonly contents: string;
  readonly workspaceFolder: string;
}): ReadonlyArray<string> => {
  const npmTasks = decodeTasks(input.contents)?.tasks.filter((task) => task.type === "npm") ?? [];
  const paths = npmTasks.flatMap((task) =>
    lockfileCandidates(task, input.workspaceFolder)
      .flat()
      .map((candidate) => candidate.path),
  );
  return [...new Set(paths)];
};

export const vscodeTaskScripts = (input: {
  readonly contents: string;
  readonly os: ExecutionEnvironmentPlatformOs;
  readonly workspaceFolder: string;
  readonly existingPaths: ReadonlySet<string>;
}): ReadonlyArray<ProjectScript> => {
  // Commands are built with POSIX quoting; Windows shells would need their own.
  if (input.os === "windows") return [];
  const decoded = decodeTasks(input.contents);
  if (decoded === null) return [];
  const { file, tasks } = decoded;
  const byLabel = new Map(
    tasks.flatMap((task) => {
      const label = taskLabel(task);
      return label === undefined ? [] : [[label, task] as const];
    }),
  );
  const context: Context = {
    workspaceFolder: input.workspaceFolder,
    existingPaths: input.existingPaths,
  };

  const fullCommand = (task: Task, visiting: ReadonlySet<Task>): string | null => {
    if (visiting.has(task)) throw new UnsupportedTask({ reason: "dependsOn cycle" });
    const nextVisiting = new Set([...visiting, task]);
    const dependencies = dependencyLabels(task).map((label) => {
      const dependency = byLabel.get(label);
      if (dependency === undefined) throw new UnsupportedTask({ reason: label });
      return fullCommand(dependency, nextVisiting);
    });
    const runnableDependencies = dependencies.filter((command) => command !== null);
    const sequence = task.dependsOrder === "sequence" || runnableDependencies.length < 2;
    const dependencyCommand = sequence
      ? runnableDependencies
      : [`{ ${runnableDependencies.map((command) => `(${command}) &`).join(" ")} wait; }`];
    const own = ownCommand(task, file, input.os, context);
    const steps = [...dependencyCommand, ...(own === null ? [] : [own])];
    return steps.length === 0 ? null : steps.join(" && ");
  };

  return tasks.flatMap((task) => {
    const label = taskLabel(task)?.trim();
    if (task.hide === true || !label) return [];
    try {
      const command = fullCommand(task, new Set())?.trim();
      if (!command) return [];
      return [
        {
          id: `${SCRIPT_ID_PREFIX}${label}`,
          name: label,
          command,
          icon: taskIcon(task),
          runOnWorktreeCreate: false,
        },
      ];
    } catch (error) {
      if (isUnsupportedTask(error)) return [];
      throw error;
    }
  });
};
