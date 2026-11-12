const fanoutInFlightByRouteKey = new Map<string, number>();

// The composer registers its in-flight probe when it loads; without a composer nothing is sending.
let sendInFlight: (routeKey: string) => boolean = () => false;

export const registerSendInFlightProbe = (probe: (routeKey: string) => boolean) => {
  sendInFlight = probe;
};

export const fanoutInFlight = (routeKey: string) => fanoutInFlightByRouteKey.get(routeKey) ?? 0;

export const beginFanoutSend = (routeKey: string): (() => void) => {
  fanoutInFlightByRouteKey.set(routeKey, fanoutInFlight(routeKey) + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    fanoutInFlightByRouteKey.set(routeKey, fanoutInFlight(routeKey) - 1);
  };
};

export const hasPendingDraftSend = (routeKey: string): boolean =>
  sendInFlight(routeKey) || fanoutInFlight(routeKey) > 0;
