import { describe, expect, it } from "vite-plus/test";
import { beginFanoutSend, draftSendState, hasPendingDraftSend } from "./chatViewSend";

describe("overlapping multiple-model sends", () => {
  it("keeps the route busy until every fanout finishes, even out of order", () => {
    const routeKey = "temporary-overlapping-fanout";
    const finishFirst = beginFanoutSend(routeKey);
    const finishSecond = beginFanoutSend(routeKey);
    expect(draftSendState(routeKey).fanoutInFlight.current).toBe(2);
    expect(hasPendingDraftSend(routeKey)).toBe(true);
    finishFirst();
    finishFirst();
    expect(draftSendState(routeKey).fanoutInFlight.current).toBe(1);
    expect(hasPendingDraftSend(routeKey)).toBe(true);
    finishSecond();
    expect(draftSendState(routeKey).fanoutInFlight.current).toBe(0);
    expect(hasPendingDraftSend(routeKey)).toBe(false);
  });
});
