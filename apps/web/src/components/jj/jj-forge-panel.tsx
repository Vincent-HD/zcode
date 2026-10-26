import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { EnvironmentId, JjPanelReady, ProjectId } from "@t3tools/contracts";
import { useServerConfigs } from "~/state/entities";
import { jjEnvironment } from "~/state/jj";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { JjForgeSection, type JjForgeSectionProps } from "./JjForgeSection";

const requireSuccess = <A, E>(result: AtomCommandResult<A, E>): A => {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
};

export const JjForgePanel = (props: {
  panel: JjPanelReady;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  disabled: boolean;
  onOpenPullRequest: JjForgeSectionProps["onOpenPullRequest"];
  onPublished: () => void;
}) => {
  const configs = useServerConfigs();
  const supported =
    configs.get(props.environmentId)?.environment.capabilities.jjPanelForge === true;
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const canPublish = useAtomValue(jjEnvironment.forgePublish.permissionAtom(props.environmentId));
  const preview = useAtomCommand(jjEnvironment.forgePreview, { reportFailure: false });
  const publish = useAtomCommand(jjEnvironment.forgePublish, { reportFailure: false });
  const status = useAtomCommand(jjEnvironment.forgeStatus, { reportFailure: false });
  if (!supported) return null;
  return (
    <JjForgeSection
      panel={props.panel}
      environmentId={props.environmentId}
      projectId={props.projectId}
      disabled={props.disabled}
      canRead={canRead}
      canPublish={canPublish}
      onPreview={async (input) => requireSuccess(await preview(input))}
      onPublish={async (input) => requireSuccess(await publish(input))}
      onRefreshStatus={async (input) => requireSuccess(await status(input))}
      onOpenPullRequest={props.onOpenPullRequest}
      onPublished={props.onPublished}
    />
  );
};
