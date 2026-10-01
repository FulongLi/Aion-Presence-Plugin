/**
 * Aion's identity: who Aion is. This is the one canonical place for these facts. Tool descriptions, the
 * surface and the docs read them from here, so the wording may vary while the facts cannot drift apart.
 *
 * Identity is deliberately separate from Aion's state (what it is doing, see state.ts) and its body
 * (what visual form it occupies, see body.ts). Nothing here knows about rendering or about the host.
 */
export interface AionIdentity {
  /** The entity's name. */
  readonly name: string;
  /** The product/system that gives Aion its visual presence. */
  readonly product: string;
  readonly creatorCompany: string;
  readonly leadCreator: string;
  /** What Aion is, in plain words. */
  readonly nature: string;
}

export const AION_IDENTITY: AionIdentity = Object.freeze({
  name: "Aion",
  product: "Intelligent Presence",
  creatorCompany: "Spirit Connect",
  leadCreator: "Fulong",
  nature: "interactive AI presence",
});

/**
 * Aion's role when a host agent (Codex, or a future host) is the intelligence. Aion is never a second
 * model, assistant or personality: it is the body through which the host agent is seen.
 */
export function embodimentStatement(host = "the host agent", identity: AionIdentity = AION_IDENTITY) {
  return `${identity.name} is not a separate AI model or assistant. ${identity.name} is the visual body of ${host}: `
    + `${host} does the reasoning and the work, and ${identity.name} presents it. ${identity.product} is created by `
    + `${identity.creatorCompany}, led by ${identity.leadCreator}.`;
}
