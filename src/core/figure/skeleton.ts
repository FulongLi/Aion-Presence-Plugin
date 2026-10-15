/**
 * The Particle Figure's skeleton: named anchors in a normalized frame (x right on screen, y up, z toward
 * the viewer; the standing figure spans about y −0.9…0.86). The figure faces the viewer, so its *left* is
 * on the viewer's right (+x).
 *
 * Geometry is data: poses move anchors (pose.ts), and the particle layout binds grains to anchors
 * (layout.ts). Nothing here animates or renders.
 */
export const ANCHORS = [
  "head", "neck",
  "shoulderLeft", "shoulderRight", "elbowLeft", "elbowRight", "handLeft", "handRight",
  /** The base of the spine (pelvis centre). */
  "spine",
  "hipLeft", "hipRight", "kneeLeft", "kneeRight", "footLeft", "footRight",
  /** v0.4.4: the middle of the spine, so the torso can bend as one curve (Figure 3.0). */
  "chest",
] as const;
export type AnchorName = typeof ANCHORS[number];
export const ANCHOR_COUNT = ANCHORS.length;
export const ANCHOR = Object.fromEntries(ANCHORS.map((name, index) => [name, index])) as Record<AnchorName, number>;

/** Normalized → world units (the sphere's radius is 1.35, so the figure stands about as tall as the sphere is wide). */
export const FIGURE_SCALE = 1.65;

/**
 * Limb lengths and offsets in normalized units. Figure 2.0 reads as a clean stick figure: a round head about a
 * seventh of the height, short shoulders (so the arms hang clear of the torso and the shoulder joints show), a
 * narrow pelvis and long, even limbs.
 */
export const PROPORTIONS = {
  pelvisY: 0.06,
  torso: 0.5,
  /** Neck anchor → head centre. The head ring's radius leaves a short visible neck. */
  neck: 0.19,
  headRadius: 0.128,
  shoulderWidth: 0.11,
  shoulderDrop: 0.035,
  upperArm: 0.28,
  forearm: 0.26,
  hipWidth: 0.075,
  hipDrop: 0.025,
  thigh: 0.47,
  shin: 0.47,
  footX: 0.11,
  footY: -0.9,
};

/**
 * Figure 3.0 (v0.4.4): the limbs the layout draws, each one continuous curve through four anchors (the curve passes
 * through every anchor, smoothly: no corner at an elbow, a knee or a shoulder). The anchors stay the animation's
 * control points — poses and IK move them exactly as before — only the drawing between them changed. `lengths` are the
 * neutral lengths of the three spans (they spread the grains evenly); a repeated last anchor ends a chain early.
 * Each limb's secondary motion (its flesh lagging a little behind fast movement) is uploaded in slot LIMB_SLOT + index.
 */
export const LIMBS: readonly { name: string; chain: readonly [AnchorName, AnchorName, AnchorName, AnchorName]; lengths: readonly [number, number, number]; tone: number }[] = [
  { name: "torso", chain: ["neck", "chest", "spine", "spine"], lengths: [PROPORTIONS.torso / 2, PROPORTIONS.torso / 2, 0], tone: 0.82 },
  { name: "armLeft", chain: ["neck", "shoulderLeft", "elbowLeft", "handLeft"], lengths: [PROPORTIONS.shoulderWidth, PROPORTIONS.upperArm, PROPORTIONS.forearm], tone: 0.8 },
  { name: "armRight", chain: ["neck", "shoulderRight", "elbowRight", "handRight"], lengths: [PROPORTIONS.shoulderWidth, PROPORTIONS.upperArm, PROPORTIONS.forearm], tone: 0.8 },
  // Legs leave the pelvis together, as a clean V (the hip anchors only steer the IK); arms flow from the neck over the shoulder.
  { name: "legLeft", chain: ["spine", "kneeLeft", "footLeft", "footLeft"], lengths: [PROPORTIONS.thigh, PROPORTIONS.shin, 0], tone: 0.8 },
  { name: "legRight", chain: ["spine", "kneeRight", "footRight", "footRight"], lengths: [PROPORTIONS.thigh, PROPORTIONS.shin, 0], tone: 0.8 },
];
/** The anchor at the middle of each limb, whose motion its secondary motion follows. */
export const LIMB_MIDDLES: readonly AnchorName[] = ["chest", "elbowLeft", "elbowRight", "kneeLeft", "kneeRight"];
/** Uniform slots: the anchors, then one secondary-motion offset per limb (world units). */
export const LIMB_SLOT = ANCHOR_COUNT;
export const FIGURE_SLOTS = ANCHOR_COUNT + LIMBS.length;

/**
 * Hands and feet end in a small, soft round (the same light as the limbs) so the ends of the limbs read; Figure 3.0
 * has no joint beads.
 */
export const TIPS: readonly [AnchorName, number, number][] = [
  ["handLeft", 0.011, 0.84], ["handRight", 0.011, 0.84], ["footLeft", 0.012, 0.84], ["footRight", 0.012, 0.84],
];

/** Figure 2.0's straight bones (kept as the reference skeleton for tests and diagnostics): [from, to, relative density, tone]. */
export const BONES: readonly [AnchorName, AnchorName, number, number][] = [
  ["neck", "spine", 1, 0.8],
  ["neck", "shoulderLeft", 1, 0.78], ["neck", "shoulderRight", 1, 0.78],
  ["shoulderLeft", "elbowLeft", 1, 0.8], ["shoulderRight", "elbowRight", 1, 0.8],
  ["elbowLeft", "handLeft", 1, 0.8], ["elbowRight", "handRight", 1, 0.8],
  ["spine", "hipLeft", 1, 0.76], ["spine", "hipRight", 1, 0.76],
  ["hipLeft", "kneeLeft", 1, 0.8], ["hipRight", "kneeRight", 1, 0.8],
  ["kneeLeft", "footLeft", 1, 0.8], ["kneeRight", "footRight", 1, 0.8],
];

/**
 * Figure 2.0's joint beads (no longer drawn; kept for reference): [anchor, radius (normalized), tone]. Shoulders, elbows, hips and knees are
 * clear points; hands and feet a little larger, so the ends of the limbs read.
 */
export const JOINTS: readonly [AnchorName, number, number][] = [
  ["neck", 0.012, 0.9], ["spine", 0.015, 0.9],
  ["shoulderLeft", 0.016, 0.95], ["shoulderRight", 0.016, 0.95],
  ["elbowLeft", 0.016, 0.95], ["elbowRight", 0.016, 0.95],
  ["handLeft", 0.022, 1], ["handRight", 0.022, 1],
  ["hipLeft", 0.015, 0.9], ["hipRight", 0.015, 0.9],
  ["kneeLeft", 0.016, 0.95], ["kneeRight", 0.016, 0.95],
  ["footLeft", 0.021, 1], ["footRight", 0.021, 1],
];
