import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { use } from "react";

import { useThreadProjection } from "../../state/entities";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { TurnUsage } from "./turn-usage";
import { resolveUsageTurn } from "./turn-usage.logic";

type ProjectedItem = Extract<TimelineRow, { kind: "message" }>["projectedItem"];

const ProjectedTurnUsage = ({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<ProjectedItem>;
}) => {
  const ctx = use(TimelineRowCtx);
  const source = useThreadProjection(
    scopeThreadRef(ctx.activeThreadEnvironmentId, projectedItem.sourceThreadId),
  );
  const data =
    source && projectedItem.item.providerTurnId
      ? resolveUsageTurn({
          projection: source.projection,
          providerTurnId: projectedItem.item.providerTurnId,
          runId: projectedItem.item.runId,
        })
      : null;
  return data ? <TurnUsage data={data} /> : null;
};

/** Usage for a finished assistant message's provider turn. */
export const AssistantTurnUsage = (props: {
  readonly projectedItem: ProjectedItem;
  readonly streaming: boolean;
}) =>
  props.projectedItem?.item.type === "assistant_message" && !props.streaming ? (
    <ProjectedTurnUsage projectedItem={props.projectedItem} />
  ) : null;
