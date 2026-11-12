import * as Layer from "effect/Layer";

import * as JjForgeService from "../jj/JjForgeService.ts";
import * as JjPanelService from "../jj/JjPanelService.ts";

export const layer = JjForgeService.layer.pipe(Layer.provideMerge(JjPanelService.layer));
