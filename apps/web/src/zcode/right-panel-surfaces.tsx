import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { GitBranch } from "lucide-react";
import { lazy, Suspense } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import type { JjOpenDiffInput } from "../components/jj/JjPanel";
import { selectJjRevision } from "./jj-diff-selection";
import type { ZcodeRightPanelKind, ZcodeRightPanelSurface } from "./right-panel-kinds";

const JjPanel = lazy(() => import("../components/jj/JjPanel"));

export interface ZcodeRightPanelContext {
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | null;
  readonly projectId: ProjectId | null;
  readonly isServerThread: boolean;
}

const ZCODE_SURFACES = {
  jj: { title: "Jujutsu", Icon: GitBranch },
} satisfies Record<ZcodeRightPanelKind, { title: string; Icon: typeof GitBranch }>;

export const zcodeSurfaceTitle = (surface: ZcodeRightPanelSurface) =>
  ZCODE_SURFACES[surface.kind].title;

export const ZcodeSurfaceIcon = (props: { readonly surface: ZcodeRightPanelSurface }) => {
  const Icon = ZCODE_SURFACES[props.surface.kind].Icon;
  return <Icon className="size-3 shrink-0" />;
};

export const zcodeSurfaceLaunchers = (context: ZcodeRightPanelContext) => {
  const threadRef = context.threadRef;
  const available = Boolean(context.cwd && threadRef);
  return [
    {
      label: "Jujutsu",
      icon: GitBranch,
      shortcut: "J",
      available,
      disabledReason: "Available from a project thread.",
      onClick: () => {
        if (available && threadRef) useRightPanelStore.getState().open(threadRef, "jj");
      },
    },
  ];
};

const openJjDiff = (context: ZcodeRightPanelContext, input: JjOpenDiffInput) => {
  if (!context.isServerThread || !context.threadRef) return;
  selectJjRevision(
    context.threadRef,
    input.commitId,
    input.filePath,
    input.context,
    input.fromCommitId,
  );
  useRightPanelStore.getState().open(context.threadRef, "diff");
};

/** Takes RightPanelSurfaceContent's own props, so its slot stays one line. */
export const ZcodeRightPanelSurfaceContent = (props: {
  readonly surface: ZcodeRightPanelSurface;
  readonly zcode: ZcodeRightPanelContext;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly activeSurfaceId: string | null;
}) => (
  <Suspense fallback={null}>
    <JjPanel
      key={`${props.environmentId}:${props.zcode.cwd}`}
      environmentId={props.environmentId}
      cwd={props.zcode.cwd}
      visible={props.visible && props.activeSurfaceId === props.surface.id}
      onOpenDiff={(input) => openJjDiff(props.zcode, input)}
      projectId={props.zcode.projectId ?? undefined}
      onOpenPullRequest={({ environmentId, reference }) => {
        if (environmentId !== props.environmentId) return;
        useRightPanelStore.getState().openPullRequest(props.threadRef, {
          projectId: reference.projectId,
          repository: reference.repository,
          number: reference.number,
          ...(reference.host ? { host: reference.host } : {}),
        });
      }}
    />
  </Suspense>
);

export type ZcodeSurfaceLaunchers = ReturnType<typeof zcodeSurfaceLaunchers>;
