import { useSyncExternalStore } from "react";
import { parseModelsDevPricing, type ModelsDevCatalog } from "./models-dev-pricing";

export type ModelsDevPricingState = {
  readonly catalog: ModelsDevCatalog | null;
  readonly error: string | null;
  readonly loading: boolean;
};

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const initialState: ModelsDevPricingState = { catalog: null, error: null, loading: false };
let state = initialState;
let expiresAt = 0;
let inFlight = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const publish = (next: ModelsDevPricingState) => {
  state = next;
  for (const listener of listeners) listener();
};
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  if (listeners.size === 0 || inFlight) return;
  refreshTimer = setTimeout(() => void refresh(), Math.max(0, expiresAt - Date.now()));
};
const refresh = async () => {
  if (inFlight) return;
  if (Date.now() < expiresAt) {
    scheduleRefresh();
    return;
  }
  inFlight = true;
  publish({ ...state, loading: true, error: null });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
    const document: unknown = await response.json();
    const catalog = parseModelsDevPricing(document);
    if (!catalog) throw new Error("models.dev returned an invalid pricing catalog");
    publish({ catalog, error: null, loading: false });
  } catch (error) {
    publish({
      catalog: state.catalog,
      error: controller.signal.aborted
        ? "models.dev request timed out"
        : error instanceof Error
          ? error.message
          : "models.dev request failed",
      loading: false,
    });
  } finally {
    clearTimeout(timeout);
    expiresAt = Date.now() + (state.error ? 60_000 : TTL_MS);
    inFlight = false;
    scheduleRefresh();
  }
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  void refresh();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  };
};
const getSnapshot = () => state;
const getServerSnapshot = () => initialState;

/** One unauthenticated catalog request is shared by every mounted consumer. */
export const useModelsDevPricing = (): ModelsDevPricingState =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
