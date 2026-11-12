/** Temporary conversations stay open, so background send shortcuts do nothing there. */
export const blocksTemporaryShortcut = (
  isTemporaryConversation: boolean | undefined,
  command: string | null,
) =>
  isTemporaryConversation === true &&
  (command === "composer.sendBackground" || command === "composer.sendAndNewThread");
