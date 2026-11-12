import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

export const TEMPORARY_CONVERSATIONS_KEY = "zcode:temporary-conversations:v1";
// uiStateStore's PERSISTED_STATE_KEY, which held the markers before they moved here.
export const LEGACY_UI_STATE_KEY = "t3code:ui-state:v1";

export interface TemporaryConversationState {
  readonly temporaryThreadKeys: string[];
}

export const parseTemporaryThreadKeys = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (threadKey): threadKey is string =>
          typeof threadKey === "string" && parseScopedThreadKey(threadKey) !== null,
      )
    : [];

const readStoredKeys = (raw: string | null): string[] | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parseTemporaryThreadKeys(
      typeof parsed === "object" && parsed !== null && "temporaryThreadKeys" in parsed
        ? parsed.temporaryThreadKeys
        : parsed,
    );
  } catch {
    return [];
  }
};

const storage = () =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined"
    ? window.localStorage
    : null;

const persistKeys = (temporaryThreadKeys: readonly string[]) => {
  try {
    storage()?.setItem(TEMPORARY_CONVERSATIONS_KEY, JSON.stringify(temporaryThreadKeys));
  } catch {
    // Storage can be unavailable or full; the marker then lasts for this session only.
  }
};

// Markers lived in the UI state blob before the fork moved them; copy them once.
export const hydrateTemporaryThreadKeys = (): string[] => {
  try {
    const current = readStoredKeys(storage()?.getItem(TEMPORARY_CONVERSATIONS_KEY) ?? null);
    if (current !== null) return current;
    const legacy = readStoredKeys(storage()?.getItem(LEGACY_UI_STATE_KEY) ?? null) ?? [];
    persistKeys(legacy);
    return legacy;
  } catch {
    return [];
  }
};

export const setTemporaryThread = (
  state: TemporaryConversationState,
  threadKey: string,
  temporary: boolean,
): TemporaryConversationState => {
  const keys = new Set(state.temporaryThreadKeys);
  if (temporary === keys.has(threadKey)) return state;
  if (temporary) keys.add(threadKey);
  else keys.delete(threadKey);
  return { temporaryThreadKeys: [...keys] };
};

export const transferTemporaryThreads = (
  state: TemporaryConversationState,
  fromKeys: readonly string[],
  toKey: string,
): TemporaryConversationState => {
  const sourceKeys = new Set(fromKeys.filter((key) => key !== toKey));
  if (!state.temporaryThreadKeys.some((threadKey) => sourceKeys.has(threadKey))) return state;
  return {
    temporaryThreadKeys: [
      ...state.temporaryThreadKeys.filter(
        (threadKey) => !sourceKeys.has(threadKey) && threadKey !== toKey,
      ),
      toKey,
    ],
  };
};

interface TemporaryConversationStore extends TemporaryConversationState {
  readonly setTemporaryThread: (threadKey: string, temporary: boolean) => void;
  readonly transferTemporaryThread: (fromKey: string, toKey: string) => void;
  readonly transferTemporaryThreads: (fromKeys: readonly string[], toKey: string) => void;
}

const update =
  (next: (state: TemporaryConversationState) => TemporaryConversationState) =>
  (state: TemporaryConversationStore) => {
    const nextState = next(state);
    if (nextState.temporaryThreadKeys !== state.temporaryThreadKeys) {
      persistKeys(nextState.temporaryThreadKeys);
    }
    return nextState;
  };

export const useTemporaryConversationStore = create<TemporaryConversationStore>((set) => ({
  temporaryThreadKeys: hydrateTemporaryThreadKeys(),
  setTemporaryThread: (threadKey, temporary) =>
    set(update((state) => setTemporaryThread(state, threadKey, temporary))),
  transferTemporaryThread: (fromKey, toKey) =>
    set(update((state) => transferTemporaryThreads(state, [fromKey], toKey))),
  transferTemporaryThreads: (fromKeys, toKey) =>
    set(update((state) => transferTemporaryThreads(state, fromKeys, toKey))),
}));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== TEMPORARY_CONVERSATIONS_KEY) return;
    useTemporaryConversationStore.setState({
      temporaryThreadKeys: readStoredKeys(event.newValue) ?? [],
    });
  });
}

export const isTemporaryThreadKey = (threadKey: string) =>
  useTemporaryConversationStore.getState().temporaryThreadKeys.includes(threadKey);

export const useIsTemporaryThread = (threadKeys: ReadonlyArray<string>) =>
  useTemporaryConversationStore((state) =>
    threadKeys.some((key) => state.temporaryThreadKeys.includes(key)),
  );
