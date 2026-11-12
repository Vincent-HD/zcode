import { expect, it } from "vite-plus/test";

import {
  LEGACY_UI_STATE_KEY,
  TEMPORARY_CONVERSATIONS_KEY,
  hydrateTemporaryThreadKeys,
  useTemporaryConversationStore,
} from "./temporary-conversation-store";

it("migrates markers persisted in the UI state blob once", () => {
  try {
    window.localStorage.removeItem(TEMPORARY_CONVERSATIONS_KEY);
    window.localStorage.setItem(
      LEGACY_UI_STATE_KEY,
      JSON.stringify({ temporaryThreadKeys: ["environment-1:thread-1", "invalid"] }),
    );
    expect(hydrateTemporaryThreadKeys()).toEqual(["environment-1:thread-1"]);
    expect(JSON.parse(window.localStorage.getItem(TEMPORARY_CONVERSATIONS_KEY) ?? "null")).toEqual([
      "environment-1:thread-1",
    ]);

    window.localStorage.setItem(LEGACY_UI_STATE_KEY, JSON.stringify({ temporaryThreadKeys: [] }));
    useTemporaryConversationStore.setState({ temporaryThreadKeys: ["environment-1:thread-1"] });
    useTemporaryConversationStore.getState().setTemporaryThread("environment-1:thread-2", true);
    expect(hydrateTemporaryThreadKeys()).toEqual([
      "environment-1:thread-1",
      "environment-1:thread-2",
    ]);
  } finally {
    useTemporaryConversationStore.setState({ temporaryThreadKeys: [] });
    window.localStorage.removeItem(TEMPORARY_CONVERSATIONS_KEY);
    window.localStorage.removeItem(LEGACY_UI_STATE_KEY);
  }
});
