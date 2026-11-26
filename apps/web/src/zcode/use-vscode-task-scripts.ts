import {
  FILESYSTEM_METADATA_BATCH_LIMIT,
  type EnvironmentId,
  type ProjectScript,
} from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useGT } from "gt-react";

import { useProjectFileQuery } from "../components/files/projectFilesQueryState";
import type {
  NewProjectScriptInput,
  ProjectScriptActionResult,
} from "../components/ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useServerConfigs } from "../state/entities";
import { filesystemEnvironment } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import {
  isVscodeTaskScriptId,
  packageManagerProbePaths,
  VSCODE_TASKS_FILE,
  vscodeTaskScripts,
} from "./vscode-tasks";

const NO_SCRIPTS: ReadonlyArray<ProjectScript> = [];
const NO_PATHS: ReadonlyArray<string> = [];

/**
 * Appends the project's VS Code tasks to its scripts. Editing a task saves it as a T3 action,
 * which then hides the task because it shares its name.
 */
export const useVscodeTaskScripts = (input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  readonly onAddScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  readonly onUpdateScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  readonly onDeleteScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}) => {
  const gt = useGT();
  const query = useProjectFileQuery(
    input.environmentId,
    input.cwd ?? "",
    VSCODE_TASKS_FILE,
    input.cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const os = useServerConfigs().get(input.environmentId)?.environment.platform.os;
  const probePaths =
    contents === null || input.cwd === null
      ? NO_PATHS
      : packageManagerProbePaths({ contents, workspaceFolder: input.cwd }).slice(
          0,
          FILESYSTEM_METADATA_BATCH_LIMIT,
        );
  const lockfiles = useEnvironmentQuery(
    probePaths.length === 0
      ? null
      : filesystemEnvironment.getMetadata({
          environmentId: input.environmentId,
          input: { paths: probePaths },
        }),
  );
  const existingPaths = new Set(
    probePaths.filter((_, index) => lockfiles.data?.entries[index]?.kind === "file"),
  );
  const tasks =
    contents === null || os === undefined || input.cwd === null
      ? NO_SCRIPTS
      : vscodeTaskScripts({ contents, os, workspaceFolder: input.cwd, existingPaths });
  const projectScripts = input.scripts ?? NO_SCRIPTS;
  const visibleTasks = tasks.filter(
    (task) =>
      !projectScripts.some(
        (script) =>
          script.command === task.command || script.name.toLowerCase() === task.name.toLowerCase(),
      ),
  );
  const scripts = visibleTasks.length === 0 ? projectScripts : [...projectScripts, ...visibleTasks];

  return {
    scripts,
    onUpdateScript: (scriptId: string, script: NewProjectScriptInput) =>
      isVscodeTaskScriptId(scriptId)
        ? input.onAddScript(script)
        : input.onUpdateScript(scriptId, script),
    onDeleteScript: async (scriptId: string): Promise<ProjectScriptActionResult> => {
      if (!isVscodeTaskScriptId(scriptId)) return input.onDeleteScript(scriptId);
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: gt("This task comes from .vscode/tasks.json. Remove it there."),
        }),
      );
      return AsyncResult.success(undefined);
    },
  };
};
