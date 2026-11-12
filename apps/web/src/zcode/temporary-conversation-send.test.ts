import { describe, expect, it } from "vite-plus/test";

import { draftSendState } from "../components/chat/chatViewSend";
import "./temporary-composer-send";
import {
  beginFanoutSend,
  fanoutInFlight,
  hasPendingDraftSend,
} from "./temporary-conversation-send";

describe("overlapping multiple-model sends", () => {
  it("keeps the route busy until every fanout finishes, even out of order", () => {
    const routeKey = "temporary-overlapping-fanout";
    const finishFirst = beginFanoutSend(routeKey);
    const finishSecond = beginFanoutSend(routeKey);
    expect(fanoutInFlight(routeKey)).toBe(2);
    expect(hasPendingDraftSend(routeKey)).toBe(true);
    finishFirst();
    finishFirst();
    expect(fanoutInFlight(routeKey)).toBe(1);
    expect(hasPendingDraftSend(routeKey)).toBe(true);
    finishSecond();
    expect(fanoutInFlight(routeKey)).toBe(0);
    expect(hasPendingDraftSend(routeKey)).toBe(false);
  });

  it("reports a single in-flight composer send once the composer is loaded", () => {
    const routeKey = "temporary-single-send";
    draftSendState(routeKey).sendInFlight.current = true;
    expect(hasPendingDraftSend(routeKey)).toBe(true);
    draftSendState(routeKey).sendInFlight.current = false;
    expect(hasPendingDraftSend(routeKey)).toBe(false);
  });
});
