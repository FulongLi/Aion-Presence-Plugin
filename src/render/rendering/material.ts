import type { Node } from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { float, mix, normalize, positionLocal, sin, smoothstep, uv, vec3 } from "three/tsl";
import type { PhysicsUniforms } from "../physics/uniforms";
import { bodyWeight, eyesWeight, formedTarget, morphWeight } from "../physics/morph";
import { figureRest } from "../physics/figure";
import { eyesRest } from "../physics/eyes";
import { ringRest, ringWeight } from "../physics/ring";
import { writingLight, writingSize, writingTarget } from "../physics/writing";
type VectorNode = Node;

/** Aion's other bodies: each particle's skeleton binding (core/figure/layout.ts) and eye binding (core/eyes/layout.ts). */
export interface FigureInputs { bind: VectorNode; local: VectorNode; eyesBind?: VectorNode; eyesLocal?: VectorNode }

export function createMaterial(rest: VectorNode, offset: VectorNode, target: VectorNode, tone: VectorNode, u: PhysicsUniforms,
  figure?: FigureInputs, writingKey: VectorNode = float(-1)) {
  const material = new MeshBasicNodeMaterial();
  const m = morphWeight(rest, u);
  // The persistent body under every visual: the sphere, the figure or the eyes (weights 0 leave the sphere unchanged).
  const figured = figure ? figureRest(figure.bind, figure.local, u) : null;
  const eyed = figure?.eyesBind && figure.eyesLocal ? eyesRest(figure.eyesBind, figure.eyesLocal, u) : null;
  const b = figured ? bodyWeight(rest, u) : float(0);
  const e = eyed ? eyesWeight(rest, u) : float(0);
  const figureRestPosition = figured ? mix(rest, figured.position, b) : rest;
  const persistentRest = eyed ? mix(figureRestPosition, eyed.position, e) : figureRestPosition;
  // The circular audio spectrum (v0.4.2): the same expression as in compute, and how bright each grain's band is.
  const ring = ringRest(rest, u), w = ringWeight(rest, u);
  const bodyRest = mix(persistentRest, ring.position, w);
  const normal = normalize(rest.add(offset).add(vec3(0, 0.0001, 0)));
  const key = normal.dot(normalize(vec3(-0.7, 1, 1.7))).add(u.wrap).div(u.wrap.add(1)).clamp(0, 1);
  const fill = normal.dot(normalize(vec3(1, -0.3, -0.6))).add(u.wrap).div(u.wrap.add(1)).clamp(0, 1);
  // Attention and focus lift the light a little: the body "turns toward" the user.
  // Answering adds a faint warm light that rises with the swell (see presenceField.ts).
  const answerLight = sin(u.clock.mul(u.responseSpeed).sub(rest.y.mul(1.2))).mul(0.5).add(0.5).mul(u.responding).mul(u.responseGlow);
  // Sound lifts the sphere's light a little with its loudness and beats (v0.4.2).
  const soundLight = u.audioLevel.mul(0.12).add(u.audioBeat.mul(0.1)).mul(u.sphereAudio).mul(u.audioGain.min(1.3));
  const attentionLight = u.attention.mul(u.listeningGlow).add(u.focusPulse.mul(u.focusGlow)).add(u.listeningAudio.mul(u.listeningGlow)).add(answerLight).add(soundLight);
  const light = key.mul(u.key).add(fill.mul(u.fill)).add(u.ambient).add(attentionLight);
  const color = mix(u.baseColor, u.warmColor, u.warmth.mul(0.28));
  const disturbance = offset.length().mul(0.28).clamp(0, 0.22);
  // Stable size variation keeps individual grains legible without frame-to-frame flicker.
  const grainSize = sin(rest.dot(vec3(127.1, 311.7, 74.7))).mul(0.3).add(1);
  // A writing target (v0.4.3): the pen's grains ride the tip; strokes are lit as they are written (render/writing.ts).
  const formed = formedTarget(writingTarget(target, writingKey, u), u);
  const base = mix(bodyRest, formed, m);
  const depthSway = sin(u.clock.mul(0.5)).mul(0.07).mul(m).mul(float(1).sub(u.formedDepth));
  const relief = vec3(base.x.add(base.z.mul(depthSway)), base.y, base.z);
  // Formed visuals and the figure use slightly finer grains than the sphere; the eyes their own (a fine edge, a dense fill).
  const restGrain = mix(float(1).sub(b.mul(0.34)), eyed ? eyed.grain : float(0.7), e);
  const grain = positionLocal.mul(u.size).mul(grainSize).mul(mix(mix(restGrain, float(0.86), w), float(0.76).mul(writingSize(writingKey, u)), m));
  material.positionNode = grain.add(relief).add(offset);
  const accentLight = smoothstep(0.25, 0.95, normal.dot(normalize(u.voiceDirection)))
    .mul(u.voiceAccent).mul(0.08).mul(u.speechGain);
  // A formed visual brightens very slightly with the voice: alive, never flickering.
  const formedLight = float(1).add(u.voiceBody.mul(u.formedShimmer).mul(0.16));
  const sphereColor = color.mul(light).add(disturbance).add(accentLight);
  // The figure is lit by its own tones (bright bones and joints, faint veil and dust), in the sphere's
  // palette, brightening slightly as it turns toward the user and with the voice.
  const figureLight = float(1.25).add(attentionLight.mul(2)).add(u.voiceBody.mul(0.12));
  const figureColor = figured ? mix(sphereColor, color.mul(figured.tone).mul(figureLight).add(disturbance.mul(0.5)), b) : sphereColor;
  // The eyes are lit by their own tones too: a bright rim and iris, a faint glassy fill.
  const bodyRestColor = eyed ? mix(figureColor, color.mul(eyed.tone).mul(figureLight).add(disturbance.mul(0.5)), e) : figureColor;
  // A ring grain glows with its band: quiet bands are dim silver, loud ones bright (restrained: no colour of its own).
  const ringLight = float(0.62).add(ring.energy.mul(0.95)).add(u.audioBeat.mul(0.12)).mul(mix(float(1), float(0.85), ring.core));
  const restColor = mix(bodyRestColor, color.mul(ringLight).add(disturbance.mul(0.4)), w);
  // A 3D object is lit by depth: what is nearer is brighter, so its structure reads as it turns.
  const nearness = mix(float(1), smoothstep(-1.9, 1.9, formed.z).mul(0.62).add(0.5), u.formedDepth);
  const bodyColor = mix(restColor, u.formedColor.mul(tone).mul(formedLight).mul(nearness).mul(writingLight(writingKey, u)), m);
  material.colorNode = bodyColor;
  material.opacityNode = float(1).sub(smoothstep(0.24, 0.5, uv().sub(0.5).length()));
  material.alphaTest = 0.12;
  return material;
}
