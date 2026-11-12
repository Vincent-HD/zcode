export const ZCODE_RIGHT_PANEL_KINDS = ["jj"] as const;

export type ZcodeRightPanelKind = (typeof ZCODE_RIGHT_PANEL_KINDS)[number];

export type ZcodeRightPanelSurface = { id: ZcodeRightPanelKind; kind: ZcodeRightPanelKind };

export const isZcodeRightPanelKind = (kind: string): kind is ZcodeRightPanelKind =>
  ZCODE_RIGHT_PANEL_KINDS.some((candidate) => candidate === kind);

export const isZcodeRightPanelSurface = <Surface extends { readonly kind: string }>(
  surface: Surface,
): surface is Extract<Surface, ZcodeRightPanelSurface> => isZcodeRightPanelKind(surface.kind);

export const zcodeSingletonSurface = (kind: ZcodeRightPanelKind): ZcodeRightPanelSurface => ({
  id: kind,
  kind,
});

/** Every fork surface browses the workspace, so reopening one needs it. */
export const zcodeSurfaceRequiresWorkspace = (surface: { readonly kind: string }) =>
  isZcodeRightPanelKind(surface.kind);
