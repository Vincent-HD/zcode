import * as Layer from "effect/Layer";

import * as JjCommitMessageService from "../jj/JjCommitMessageService.ts";
import * as JjForgeService from "../jj/JjForgeService.ts";
import * as JjPanelService from "../jj/JjPanelService.ts";
import * as JjStackService from "../jj/JjStackService.ts";

export const layer = Layer.mergeAll(
  JjForgeService.layer.pipe(Layer.provideMerge(JjPanelService.layer)),
  JjCommitMessageService.layer,
  JjStackService.layer,
);
