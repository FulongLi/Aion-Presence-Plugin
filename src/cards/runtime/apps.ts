import type { CardAppFactory } from "./app";
import { createEarthMoon } from "../apps/earthMoon/app";
import { createCadViewer } from "../apps/cadViewer/app";
import { createGenerativeScene } from "../apps/generativeScene/app";
import { createRouteExplorer } from "../apps/routeExplorer/app";
import { createSimulationCard } from "../apps/simulation/app";

/**
 * The application modules inside the card runtime, by manifest `entry`. A new application is a manifest in the registry
 * (src/cards/registry.ts) and its factory here; nothing else changes.
 */
export const CARD_APP_FACTORIES: Record<string, CardAppFactory> = {
  "earth-moon": createEarthMoon,
  "cad-viewer": createCadViewer,
  "generative-scene": createGenerativeScene,
  "route-explorer": createRouteExplorer,
  "simulation": createSimulationCard,
};
