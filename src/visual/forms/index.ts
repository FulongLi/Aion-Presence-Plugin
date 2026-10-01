import { celestialPack } from "./celestial";
import { VisualFormRegistry } from "./registry";
import { symbolPack } from "./symbols";
import { taoPack } from "./tao";
import type { VisualFormPack } from "./types";

export { FORM_ID, FORM_NAME_MAX, normalizeFormName, VisualFormRegistry, type FormMatch, type RenderedForm } from "./registry";
export type * from "./types";

/**
 * Every visual form pack, in the order their forms are listed to the host agent. A new pack (math,
 * physics, chemistry, architecture, …) is one more entry here: its categories, its forms and their
 * renderers. Nothing else changes: show_visual_form, validation, the surface and the body all read the
 * registry.
 */
export const VISUAL_FORM_PACKS: readonly VisualFormPack[] = [taoPack, celestialPack, symbolPack];

/** The registry Aion uses. Pure and side-effect free: forms are only drawn when first shown. */
export const visualForms = new VisualFormRegistry(VISUAL_FORM_PACKS);
