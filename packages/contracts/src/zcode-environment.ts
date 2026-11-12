import * as Schema from "effect/Schema";

export const zcodeEnvironmentCapabilityFields = {
  /** Missing on unpatched servers; clients must not probe Jujutsu RPCs there. */
  jjPanel: Schema.optionalKey(Schema.Boolean),
  jjPanelActions: Schema.optionalKey(Schema.Boolean),
  jjPanelDiff: Schema.optionalKey(Schema.Boolean),
  jjPanelForge: Schema.optionalKey(Schema.Boolean),
};
