import { defaultCardRegistry } from "../cards/registry";
import { checkScene } from "../visual/scene3d/validate";

/**
 * The host's Application Registry (v0.4.5): the built-in applications, their body forms checked as 3D scenes. The store,
 * the hub and the MCP server all consult this one registry; nothing else can be launched.
 */
export const cardRegistry = defaultCardRegistry(scene => checkScene(scene).ok);
