import {
  AdditiveBlending, CanvasTexture, Color, DoubleSide, Group, InstancedMesh, Line, LineBasicMaterial, LineDashedMaterial, LineLoop, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points,
  PointsMaterial, Sprite, SpriteMaterial, SRGBColorSpace, type BufferGeometry, type Material, type Object3D,
} from "three";
import type { MaterialProps, SceneDocument, SceneNode } from "../../../scene/ir";
import { LINE_TYPES } from "../../../scene/ir";
import { materialOf } from "../../../scene/animation";
import { quatFromEuler, scaleVec } from "../../../scene/math";
import { pathPoints } from "../../../scene/paths";
import { nodeTriangles } from "../../../scene/validate";
import { buildGeometry, geometryClass, repeatMatrix, type GeometryClass } from "./geometry";

/**
 * The Scene Compiler (v0.5): turns a validated Scene IR document into Three.js objects, and every later revision into the
 * smallest change to them. It is a reconciler keyed by the scene's stable ids:
 *
 *   - an object whose geometry parameters are unchanged keeps its geometry; one whose material is unchanged keeps it;
 *     a colour change updates the material in place; a transform change moves the same object;
 *   - new ids are built, removed ids are released (geometry, material, textures), a new parent re-attaches the object;
 *   - building is transactional: every new geometry and material is created first, and only if all succeed is anything
 *     swapped in — a failure releases what was built and leaves the previous scene exactly as it was.
 *
 * Scene construction is separate from rendering (the ViewerEngine draws; the app animates). Each node is a holder Group
 * carrying the node's transform (animations move the holder) with its drawable inside, so children attach to the holder.
 */
export interface Entry {
  node: SceneNode;
  holder: Group;
  drawable: Object3D | null;
  geometry: BufferGeometry | null;
  material: Material | null;
  geometryKey: string;
  materialKey: string;
  kind: GeometryClass;
  texture: CanvasTexture | null;
  /** The resolved material values last applied (a shared material's change counts as an update of its users). */
  values: string;
}

export interface CompileResult { created: string[]; updated: string[]; removed: string[]; rebuilt: string[]; triangles: number }

export class CompileError extends Error {
  constructor(readonly code: "scene-compile-failed" | "resource-limit", message: string) { super(message); }
}

const GEOMETRY_KEYS = ["type", "radius", "radiusTop", "height", "size", "tube", "arc", "inner", "outer", "width", "depth", "from", "to", "points", "closed", "turns", "teeth", "thickness", "text", "textSize", "surface", "amplitude", "frequency", "resolution", "positions", "indices", "particles", "repeat"] as const;
const geometryKey = (node: SceneNode, doc: SceneDocument) => {
  const key: Record<string, unknown> = {};
  for (const k of GEOMETRY_KEYS) if (node[k as keyof SceneNode] !== undefined) key[k] = node[k as keyof SceneNode];
  // A point cloud along a path depends on that path's shape.
  const path = node.particles?.path ? doc.objects.find(n => n.id === node.particles!.path) : undefined;
  if (path) key.path = pathPoints(path)?.points;
  return JSON.stringify(key);
};

export const DEFAULT_COLOR = "#c9d3dd";

export class SceneCompiler {
  readonly root = new Group();
  readonly entries = new Map<string, Entry>();
  private doc: SceneDocument | null = null;
  triangles = 0;

  constructor(private readonly options: { maxTriangles: number; animatedOpacity: (id: string) => boolean }) {
    this.root.name = "generated-scene";
  }

  get document() { return this.doc; }

  /** The resolved material values of a node (a shared material merged under its own). */
  materialValues(node: SceneNode): MaterialProps { return this.doc ? materialOf(this.doc, node) : {}; }

  /** Applies a document: the smallest change from what is built now. Throws CompileError (nothing changed) on failure. */
  apply(doc: SceneDocument): CompileResult {
    const triangles = estimateTriangles(doc);
    if (triangles > this.options.maxTriangles) throw new CompileError("resource-limit", `the scene would build about ${triangles.toLocaleString("en")} triangles; this card allows ${this.options.maxTriangles.toLocaleString("en")}`);
    const pathOf = (id: string) => { const n = doc.objects.find(o => o.id === id); return n ? pathPoints(n)?.points ?? null : null; };
    const ids = new Set(doc.objects.map(n => n.id));
    const result: CompileResult = { created: [], updated: [], removed: [], rebuilt: [], triangles };
    // 1. Build everything new first (transactional).
    type Built = { geometry: BufferGeometry | null; material: Material | null; texture: CanvasTexture | null; geometryKey: string; materialKey: string; kind: GeometryClass; values: string };
    const built = new Map<string, Built>();
    const fresh: (BufferGeometry | Material | CanvasTexture)[] = [];
    try {
      for (const node of doc.objects) {
        const current = this.entries.get(node.id);
        const kind = geometryClass(node);
        const gKey = geometryKey(node, doc);
        const props = materialOf(doc, node);
        // Only what fixes a material's kind is in its key; colour, emission, opacity, metalness and roughness change in place.
        const transparent = (props.opacity ?? 1) < 1 || this.options.animatedOpacity(node.id);
        const mKey = JSON.stringify({
          kind, unlit: props.unlit === true, dashed: props.dashed === true, wireframe: props.wireframe === true, transparent, glow: kind === "points" && !!props.emissive,
          ...(kind === "sprite" ? { text: [node.text, node.textSize, props.color] } : {}), ...(kind === "points" ? { size: node.particles?.pointSize } : {}),
        });
        const sameGeometry = current && current.geometryKey === gKey && current.kind === kind;
        const sameMaterial = current && current.materialKey === mKey && current.kind === kind;
        let geometry: BufferGeometry | null = sameGeometry ? current.geometry : null, material: Material | null = sameMaterial ? current.material : null, texture: CanvasTexture | null = sameMaterial ? current.texture : null;
        if (!sameGeometry) { geometry = buildGeometry(node, pathOf); if (geometry) fresh.push(geometry); if (kind === "line-loop" || kind === "line") geometry?.computeBoundingSphere(); }
        if (!sameMaterial) {
          const made = makeMaterial(node, kind, props, this.options.animatedOpacity(node.id));
          material = made.material; texture = made.texture;
          if (material) fresh.push(material);
          if (texture) fresh.push(texture);
        }
        built.set(node.id, { geometry, material, texture, geometryKey: gKey, materialKey: mKey, kind, values: JSON.stringify(props) });
      }
    } catch (error) {
      for (const item of fresh) item.dispose();
      throw new CompileError("scene-compile-failed", error instanceof Error ? error.message.slice(0, 160) : "the scene could not be built");
    }
    // 2. Swap in (nothing below can fail on valid input). Material values are resolved against the new document.
    this.doc = doc;
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) continue;
      this.release(entry);
      entry.holder.removeFromParent();
      this.entries.delete(id);
      result.removed.push(id);
    }
    for (const node of doc.objects) {
      const b = built.get(node.id)!;
      let entry = this.entries.get(node.id);
      if (!entry) {
        const holder = new Group();
        holder.name = node.id;
        holder.userData.sceneId = node.id;
        entry = { node, holder, drawable: null, geometry: null, material: null, geometryKey: "", materialKey: "", kind: b.kind, texture: null, values: b.values };
        this.entries.set(node.id, entry);
        result.created.push(node.id);
      } else if (JSON.stringify(entry.node) !== JSON.stringify(node) || entry.values !== b.values) result.updated.push(node.id);
      const geometryChanged = entry.geometry !== b.geometry, materialChanged = entry.material !== b.material;
      if (geometryChanged || materialChanged || entry.kind !== b.kind) {
        if (geometryChanged && entry.geometry) entry.geometry.dispose();
        if (materialChanged) { entry.material?.dispose(); entry.texture?.dispose(); }
        if (entry.drawable) entry.holder.remove(entry.drawable);
        if (!result.created.includes(node.id)) result.rebuilt.push(node.id);
        entry.geometry = b.geometry; entry.material = b.material; entry.texture = b.texture;
        entry.drawable = makeDrawable(node, b.kind, b.geometry, b.material);
        if (entry.drawable) { entry.drawable.userData.sceneId = node.id; entry.holder.add(entry.drawable); }
      }
      entry.node = node; entry.kind = b.kind; entry.geometryKey = b.geometryKey; entry.materialKey = b.materialKey; entry.values = b.values;
      entry.holder.userData.selectable = node.selectable ?? !LINE_TYPES.includes(node.type);
      this.resetTransform(entry);
      this.resetMaterial(entry);
      entry.holder.visible = node.visible !== false;
    }
    // 3. The hierarchy (after every holder exists).
    for (const node of doc.objects) {
      const entry = this.entries.get(node.id)!;
      const parent = node.parent ? this.entries.get(node.parent)?.holder ?? this.root : this.root;
      if (entry.holder.parent !== parent) parent.add(entry.holder);
    }
    this.triangles = triangles;
    return result;
  }

  /** The node's document transform (animations then move it each frame). */
  resetTransform(entry: Entry) {
    const n = entry.node;
    entry.holder.position.set(...(n.position ?? [0, 0, 0]));
    const q = n.rotation ? quatFromEuler(n.rotation) : [0, 0, 0, 1];
    entry.holder.quaternion.set(q[0], q[1], q[2], q[3]);
    entry.holder.scale.set(...scaleVec(n.scale));
  }

  /** The node's document material values (animations then change them each frame). */
  resetMaterial(entry: Entry) {
    const m = entry.material as (Material & { color?: Color; emissive?: Color; emissiveIntensity?: number; metalness?: number; roughness?: number; opacity: number }) | null;
    if (!m) return;
    const props = this.materialValues(entry.node);
    m.opacity = props.opacity ?? 1;
    if (entry.kind === "sprite") return;
    m.color?.set(props.color ?? DEFAULT_COLOR);
    if (m.emissive) { m.emissive.set(props.emissive ?? "#000000"); m.emissiveIntensity = props.emissiveIntensity ?? (props.emissive ? 1 : 0); }
    if (m.metalness !== undefined) m.metalness = props.metalness ?? 0.05;
    if (m.roughness !== undefined) m.roughness = props.roughness ?? 0.65;
  }

  private release(entry: Entry) {
    // A sprite's quad is three.js's own geometry, shared by every sprite in this frame: released with the last of them
    // (disposing only drops its GPU buffers; a later sprite uploads it again).
    if (entry.drawable instanceof Sprite) entry.drawable.geometry.dispose();
    entry.geometry?.dispose();
    entry.material?.dispose();
    entry.texture?.dispose();
    entry.geometry = null; entry.material = null; entry.texture = null;
  }

  /** Releases everything this compiler built. */
  dispose() {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
    this.root.removeFromParent();
    this.root.clear();
    this.doc = null;
  }
}

function makeMaterial(node: SceneNode, kind: GeometryClass, props: MaterialProps, opacityAnimated: boolean): { material: Material | null; texture: CanvasTexture | null } {
  const color = new Color(props.color ?? DEFAULT_COLOR);
  const opacity = props.opacity ?? 1;
  const transparent = opacity < 1 || opacityAnimated;
  switch (kind) {
    case "none": return { material: null, texture: null };
    case "line": case "line-loop":
      return {
        material: props.dashed
          ? new LineDashedMaterial({ color, transparent, opacity, dashSize: 0.2, gapSize: 0.12 })
          : new LineBasicMaterial({ color, transparent, opacity }),
        texture: null,
      };
    case "points": {
      const size = node.particles?.pointSize ?? 3;
      return { material: new PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, opacity, depthWrite: false, blending: props.emissive ? AdditiveBlending : undefined }), texture: null };
    }
    case "sprite": {
      const texture = textTexture(node.text ?? "", props.color ?? "#e8edf2");
      return { material: new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity }), texture };
    }
    case "mesh": {
      const side = node.type === "plane" || node.type === "ring" || node.type === "parametric" || node.type === "mesh" || (node.type === "torus" && (node.arc ?? 360) < 360) ? DoubleSide : undefined;
      if (props.unlit) return { material: new MeshBasicMaterial({ color, transparent, opacity, wireframe: props.wireframe === true, side, depthWrite: !transparent || opacity > 0.6 }), texture: null };
      return {
        material: new MeshStandardMaterial({
          color, transparent, opacity, wireframe: props.wireframe === true, side, depthWrite: !transparent || opacity > 0.6,
          metalness: props.metalness ?? 0.05, roughness: props.roughness ?? 0.65,
          emissive: new Color(props.emissive ?? "#000000"), emissiveIntensity: props.emissiveIntensity ?? (props.emissive ? 1 : 0),
        }),
        texture: null,
      };
    }
  }
}

function makeDrawable(node: SceneNode, kind: GeometryClass, geometry: BufferGeometry | null, material: Material | null): Object3D | null {
  if (kind === "none" || !material) return null;
  if (kind === "sprite") {
    const sprite = new Sprite(material as SpriteMaterial);
    const h = node.textSize ?? 0.5, map = (material as SpriteMaterial).map!, ratio = (map.image as { width: number; height: number }).width / (map.image as { width: number; height: number }).height;
    sprite.scale.set(h * ratio, h, 1);
    return sprite;
  }
  if (!geometry) return null;
  const copies = node.repeat?.count ?? 1;
  if (kind === "mesh") {
    if (copies === 1) return new Mesh(geometry, material);
    const instanced = new InstancedMesh(geometry, material, copies);
    for (let i = 0; i < copies; i++) instanced.setMatrixAt(i, repeatMatrix(node, i));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    return instanced;
  }
  const one = () => {
    const object = kind === "points" ? new Points(geometry, material) : kind === "line-loop" ? new LineLoop(geometry, material) : new Line(geometry, material);
    if (material instanceof LineDashedMaterial) (object as Line).computeLineDistances();
    return object;
  };
  if (copies === 1) return one();
  const group = new Group();
  for (let i = 0; i < copies; i++) { const o = one(); o.applyMatrix4(repeatMatrix(node, i)); group.add(o); }
  return group;
}

/** A label's text drawn into a canvas (text only: nothing is parsed as markup). */
function textTexture(text: string, color: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  const font = 64, pad = 16;
  const context = canvas.getContext("2d")!;
  context.font = `500 ${font}px -apple-system, "Segoe UI", "PingFang SC", sans-serif`;
  canvas.width = Math.min(1024, Math.ceil(context.measureText(text).width) + pad * 2);
  canvas.height = font + pad * 2;
  context.font = `500 ${font}px -apple-system, "Segoe UI", "PingFang SC", sans-serif`;
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(text, pad, canvas.height / 2, canvas.width - pad * 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Triangles the compiler builds for a document (the validator's estimate, which follows the builders here). */
function estimateTriangles(doc: SceneDocument): number {
  return doc.objects.reduce((total, n) => total + nodeTriangles(n) * (n.repeat?.count ?? 1), 0);
}
