import {
  AmbientLight, Color, DirectionalLight, GridHelper, InstancedMesh, Mesh, MeshStandardMaterial, PCFSoftShadowMap, PlaneGeometry, PMREMGenerator, ShadowMaterial, Vector3,
  type Box3, type Object3D, type WebGLRenderTarget,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { ViewerEngine } from "../../runtime/engine";
import type { ResolvedStyle } from "../../../scene/style";

/**
 * Staging for generated scenes (v0.5.1): the lights, reflections, shadows, ground and backdrop a visual style asks for
 * (src/scene/style.ts), fitted to the scene's bounds. It never touches the scene's own objects except to say which
 * cast and receive shadows. Everything it creates is released on dispose (the reflections' render target, the ground
 * and the grid), and nothing is rebuilt unless the style or the bounds change.
 *
 *   key    a directional light from above and in front (the one that casts shadows)
 *   fill   a weaker one from the other side, so shadows are never black
 *   rim    one from behind, separating objects from the background
 *   room   image-based reflections of a neutral studio (three's RoomEnvironment), so metals read as metal
 */
export class SceneStage {
  readonly ambient = new AmbientLight("#b8c4d4", 0.35);
  readonly key = new DirectionalLight("#ffffff", 2.2);
  readonly fill = new DirectionalLight("#d6e0ff", 0.45);
  readonly rim = new DirectionalLight("#ffffff", 0.5);
  private ground: Mesh<PlaneGeometry, ShadowMaterial> | null = null;
  private grid: GridHelper | null = null;
  private room: WebGLRenderTarget | null = null;
  private signature = "";
  style: ResolvedStyle | null = null;

  constructor(private readonly engine: ViewerEngine) {
    const { scene, renderer } = engine;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.key.shadow.bias = -0.0004;
    scene.add(this.ambient, this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target);
    engine.addDisposer(() => this.dispose());
  }

  /**
   * Applies a style to the scene within `box`. `lit`: one of the scene's own objects lights it (a sun), so the studio
   * lights step back. `triangles`: what the scene builds (a large one gets a smaller shadow map).
   */
  apply(style: ResolvedStyle, box: Box3, lit: boolean, triangles: number) {
    const { scene, renderer } = this.engine;
    this.style = style;
    scene.background = new Color(style.background);
    renderer.toneMappingExposure = style.exposure;
    this.ambient.intensity = style.ambient;
    const dim = lit ? 0.16 : 1;
    this.key.color.set(style.key.color);
    this.key.intensity = style.key.intensity * dim;
    this.fill.intensity = style.fill * dim;
    this.rim.intensity = style.rim * dim;
    this.reflections(style.environment);
    const center = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
    const radius = box.isEmpty() ? 2 : Math.max(0.05, box.getSize(new Vector3()).length() / 2);
    const signature = JSON.stringify([style.name, style.shadows, style.ground, style.grid, style.tone, style.shadowOpacity, triangles > 120_000, ...center.toArray().map(v => round(v, radius)), round(radius, radius), round(box.min.y, radius)]);
    if (signature === this.signature) return;
    this.signature = signature;
    // Lights around the scene, at distances that follow its size.
    const place = (light: DirectionalLight, x: number, y: number, z: number) => { light.position.set(center.x + x * radius, center.y + y * radius, center.z + z * radius); light.target.position.copy(center); };
    place(this.key, 1.2, 2.2, 1.6);
    place(this.fill, -1.8, 0.7, 0.9);
    place(this.rim, -0.5, 1.4, -2);
    this.key.castShadow = style.shadows;
    if (style.shadows) {
      const shadow = this.key.shadow, camera = shadow.camera, reach = radius * 1.35;
      camera.left = -reach; camera.right = reach; camera.top = reach; camera.bottom = -reach;
      camera.near = radius * 0.05; camera.far = radius * 7;
      camera.updateProjectionMatrix();
      const size = triangles > 120_000 ? 1024 : 2048;
      if (shadow.mapSize.x !== size) { shadow.mapSize.set(size, size); shadow.map?.dispose(); shadow.map = null; }
      shadow.normalBias = radius * 0.002;
      shadow.radius = 4;
    }
    // The ground: where the scene stands (its lowest point), catching its shadows; a faint grid where the style has one.
    this.clearGround();
    const floor = box.isEmpty() ? 0 : box.min.y - radius * 0.003;
    if (style.ground && style.shadows) {
      const ground = new Mesh(new PlaneGeometry(radius * 10, radius * 10).rotateX(-Math.PI / 2), new ShadowMaterial({ opacity: style.shadowOpacity, color: style.tone === "light" ? "#3c4450" : "#000000" }));
      ground.position.set(center.x, floor, center.z);
      ground.receiveShadow = true;
      ground.userData.staging = true;
      ground.renderOrder = -1;
      scene.add(ground);
      this.ground = ground;
    }
    if (style.grid) {
      const light = style.tone === "light";
      const line = light ? "#cdd3da" : "#1c2530";
      const grid = new GridHelper(radius * 4.8, 24, line, line);
      grid.position.set(center.x, style.ground ? floor : 0, center.z);
      (grid.material as { transparent: boolean; opacity: number; depthWrite: boolean }).transparent = true;
      (grid.material as { opacity: number }).opacity = light ? 0.7 : 0.55;
      (grid.material as { depthWrite: boolean }).depthWrite = false;
      grid.userData.staging = true;
      scene.add(grid);
      this.grid = grid;
    }
  }

  /** Which of the scene's objects cast and receive shadows: lit, mostly opaque surfaces only. */
  shadowFlags(root: Object3D) {
    const on = this.style?.shadows === true;
    root.traverse(object => {
      if (!(object instanceof Mesh) && !(object instanceof InstancedMesh)) return;
      const mesh = object as Mesh;
      const material = mesh.material as MeshStandardMaterial;
      const solid = material instanceof MeshStandardMaterial && (!material.transparent || material.opacity >= 0.6) && !material.wireframe;
      mesh.castShadow = on && solid;
      mesh.receiveShadow = on && material instanceof MeshStandardMaterial;
    });
  }

  /** What the stage is doing (for the card's state). */
  describe(): { style?: ResolvedStyle["name"]; shadows?: boolean; shadowNote?: string } {
    const style = this.style;
    return style ? { style: style.name, shadows: style.shadows, ...(style.shadowNote ? { shadowNote: style.shadowNote } : {}) } : {};
  }

  private reflections(intensity: number) {
    const scene = this.engine.scene;
    if (intensity <= 0) { scene.environment = null; return; }
    if (!this.room) {
      const generator = new PMREMGenerator(this.engine.renderer);
      const room = new RoomEnvironment();
      this.room = generator.fromScene(room, 0.04);
      room.dispose();
      generator.dispose();
    }
    scene.environment = this.room.texture;
    scene.environmentIntensity = intensity;
  }

  private clearGround() {
    if (this.ground) { this.ground.removeFromParent(); this.ground.geometry.dispose(); this.ground.material.dispose(); this.ground = null; }
    if (this.grid) { this.grid.removeFromParent(); this.grid.geometry.dispose(); (this.grid.material as { dispose(): void }).dispose(); this.grid = null; }
  }

  dispose() {
    this.clearGround();
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
    if (this.room) { if (this.engine.scene.environment === this.room.texture) this.engine.scene.environment = null; this.room.dispose(); this.room = null; }
  }
}

/** A value rounded to a hundredth of the scene's size (small motions do not rebuild the stage). */
const round = (value: number, radius: number) => Math.round(value / Math.max(1e-6, radius * 0.01));
