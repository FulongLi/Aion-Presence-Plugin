import type { Box3, BufferGeometry, Material, Mesh, Object3D } from "three";
import {
  ACESFilmicToneMapping, Clock, PerspectiveCamera, Raycaster, Scene, SRGBColorSpace, Texture, Vector2, Vector3, WebGLRenderer,
  type Intersection,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ResourceStatus } from "../protocol";

/**
 * The Three.js viewer engine for interactive cards (v0.4.5): one WebGL2 renderer, a perspective camera with orbit
 * controls, picking, camera flights, resizing, an animation loop that runs only when it must, and complete disposal.
 * Applications (Earth–Moon, CAD viewer, future ones) build on it and never manage the renderer themselves.
 *
 * Rendering is on demand: a frame is drawn when something changed (the camera moved, a selection, a resize) or while an
 * application asks for continuous frames (a running simulation). Paused, nothing advances and frames are drawn only on
 * demand; suspended (the page is hidden), nothing is drawn at all. Disposal releases every geometry, material and
 * texture, the controls and the WebGL context, and stops the loop — `dispose()` reports what remained.
 */
export interface EngineOptions { reducedMotion: boolean; maxPixelRatio?: number; near?: number; far?: number; fov?: number }

export type FrameCallback = (dt: number, now: number) => void;

export class ViewerEngine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly clock = new Clock();
  private readonly callbacks = new Set<FrameCallback>();
  private readonly disposers: (() => void)[] = [];
  private frame = 0;
  private dirty = true;
  private continuous = false;
  private suspended = false;
  private disposed = false;
  private flight: { from: Vector3; to: Vector3; fromTarget: Vector3; toTarget: Vector3; t: number; seconds: number; done?: () => void } | null = null;
  private frames = 0;
  /** A physically based material has been drawn (three.js then holds its shared lookup texture; see dispose). */
  private physical = false;
  private fpsWindow = { start: performance.now(), frames: 0, fps: 0, frameMs: 0 };
  private readonly observer: ResizeObserver;

  constructor(readonly container: HTMLElement, readonly options: EngineOptions) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    if (!context) throw new Error("webgl-unavailable");
    this.renderer = new WebGLRenderer({ canvas, context, antialias: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, options.maxPixelRatio ?? 2));
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Interactive 3D view: drag to rotate, scroll or pinch to zoom, right-drag to pan, arrow keys to turn");
    canvas.style.touchAction = "none";
    container.append(canvas);
    this.camera = new PerspectiveCamera(options.fov ?? 40, 1, options.near ?? 0.01, options.far ?? 5000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !options.reducedMotion;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.listenToKeyEvents(canvas);
    this.controls.addEventListener("change", () => this.requestRender());
    this.controls.addEventListener("start", () => { this.flight = null; });
    canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); this.onContextLost?.(); });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.loop();
  }

  /** Called when the browser takes the WebGL context away (the card reports a recoverable error). */
  onContextLost?: () => void;

  get canvas() { return this.renderer.domElement; }

  /** Runs `callback` before every drawn frame (with the seconds since the last one); returns a remover. */
  onFrame(callback: FrameCallback) { this.callbacks.add(callback); return () => { this.callbacks.delete(callback); }; }

  /** Registers cleanup to run on dispose (listeners, generated textures…). */
  addDisposer(dispose: () => void) { this.disposers.push(dispose); }

  /** Draw one more frame soon. */
  requestRender() { this.dirty = true; this.wake(); }

  /** Continuous frames (a running simulation) or on demand only. */
  setContinuous(on: boolean) { this.continuous = on; if (on) this.wake(); }

  /** Suspended: no frames at all (the page is hidden); waking resumes the loop. */
  setSuspended(on: boolean) {
    this.suspended = on;
    if (on) { cancelAnimationFrame(this.frame); this.frame = 0; } else { this.clock.getDelta(); this.requestRender(); }
  }

  get rendering() { return !this.disposed && !this.suspended && this.frame !== 0; }

  private wake() { if (!this.frame && !this.suspended && !this.disposed) this.frame = requestAnimationFrame(this.tick); }

  private loop() { this.wake(); }

  private tick = (now: number) => {
    this.frame = 0;
    if (this.disposed || this.suspended) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    let moving = false;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.seconds);
      const k = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.from, f.to, k);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
      if (f.t >= 1) { this.flight = null; f.done?.(); }
      moving = true;
    }
    for (const callback of this.callbacks) callback(dt, now);
    // Damping keeps the view gliding a moment after the user lets go.
    if (this.controls.update(dt)) moving = true;
    if (this.dirty || this.continuous || moving) {
      this.dirty = false;
      const start = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.frames++;
      if (!this.physical) this.physical = (this.renderer.info.programs ?? []).some(program => /MeshStandardMaterial|MeshPhysicalMaterial/.test((program as { type?: string }).type ?? ""));
      const w = this.fpsWindow;
      w.frames++;
      w.frameMs = w.frameMs * 0.9 + (performance.now() - start) * 0.1;
      if (now - w.start >= 1000) { w.fps = w.frames * 1000 / (now - w.start); w.frames = 0; w.start = now; }
    }
    if (this.continuous || moving || this.dirty) this.wake();
  };

  resize() {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** The nearest visible object under a point of the card (client pixels), among `objects` and their descendants. */
  pick(clientX: number, clientY: number, objects: Object3D[]): Intersection | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(objects, true).filter(hit => isShown(hit.object) && (hit.object as Mesh).isMesh);
    return hits[0] ?? null;
  }

  /** Where a world point is in the card, 0…1 across and down; null when behind the camera or outside the view. */
  screenOf(point: Vector3): { x: number; y: number } | null {
    const p = point.clone().project(this.camera);
    if (p.z < -1 || p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return null;
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }

  /** Moves the camera to a position and target, eased (instantly under reduced motion). */
  flyTo(position: Vector3, target: Vector3, seconds = 1.2, done?: () => void) {
    if (this.options.reducedMotion || seconds <= 0) {
      this.flight = null;
      this.camera.position.copy(position); this.controls.target.copy(target);
      this.controls.update(); this.requestRender(); done?.();
      return;
    }
    this.flight = { from: this.camera.position.clone(), to: position.clone(), fromTarget: this.controls.target.clone(), toTarget: target.clone(), t: 0, seconds, done };
    this.wake();
  }

  /**
   * Moves the camera, its target and any flight in progress by `delta` (following a moving object without losing the
   * user's own offset or the flight toward it).
   */
  shift(delta: Vector3) {
    if (!delta.lengthSq()) return;
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    if (this.flight) { this.flight.from.add(delta); this.flight.to.add(delta); this.flight.fromTarget.add(delta); this.flight.toTarget.add(delta); }
    this.requestRender();
  }

  /** A camera position that frames a box from a direction. */
  framing(box: Box3, direction: Vector3, margin = 1.25): { position: Vector3; target: Vector3; distance: number } {
    const center = box.getCenter(new Vector3()), size = box.getSize(new Vector3());
    const radius = Math.max(1e-6, size.length() / 2);
    const fov = this.camera.fov * Math.PI / 180, fovH = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const distance = radius * margin / Math.sin(Math.min(fov, fovH) / 2);
    return { position: center.clone().add(direction.clone().normalize().multiplyScalar(distance)), target: center, distance };
  }

  status(): ResourceStatus {
    const info = this.renderer.info;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: Math.round(this.fpsWindow.fps * 10) / 10, frameMs: Math.round(this.fpsWindow.frameMs * 100) / 100,
      drawCalls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures,
      programs: info.programs?.length ?? 0, rendering: this.rendering,
      ...(memory ? { heapMB: Math.round(memory.usedJSHeapSize / 1048576 * 10) / 10 } : {}),
    };
  }

  /** Releases an object tree's geometries, materials and textures (not shared ones still in use elsewhere). */
  static release(root: Object3D) {
    root.traverse(object => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) releaseMaterial(material);
    });
  }

  /** Stops everything and releases every resource; returns what is left (all zero when nothing leaked). */
  dispose(): { geometries: number; textures: number; loops: number } {
    if (this.disposed) return { geometries: 0, textures: 0, loops: 0 };
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.callbacks.clear();
    this.observer.disconnect();
    // three.js keeps one lookup texture of its own for physically based materials (the DFG LUT, shared by every renderer
    // in this document and released with the context): it is the renderer's, not the application's, so it is not counted.
    const shared = this.physical ? 1 : 0;
    for (const dispose of this.disposers.splice(0)) { try { dispose(); } catch { /* keep releasing */ } }
    ViewerEngine.release(this.scene);
    if (this.scene.environment) { this.scene.environment.dispose(); this.scene.environment = null; }
    if (this.scene.background instanceof Texture) this.scene.background.dispose();
    this.scene.clear();
    this.controls.dispose();
    this.renderer.renderLists.dispose();
    const left = { geometries: this.renderer.info.memory.geometries, textures: Math.max(0, this.renderer.info.memory.textures - shared), loops: this.frame ? 1 : 0 };
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    return left;
  }
}

/** Whether an object and all its ancestors are visible. */
export function isShown(object: Object3D | null): boolean {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

export function releaseMaterial(material: Material) {
  for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
  material.dispose();
}

export function releaseGeometry(geometry: BufferGeometry | undefined) { geometry?.dispose(); }
