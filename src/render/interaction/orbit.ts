/**
 * How a formed 3D object is viewed: it turns slowly about its vertical axis, the user can drag to turn and tilt it,
 * scroll or pinch to zoom, and double-click to return to the default view; commands ("rotate it", "from above", "zoom
 * in") ease to a new view. Pure state plus optional DOM listeners; the runtime reads `sample()` each frame.
 */
export interface OrbitView {
  /** Turn about the vertical axis and elevation (radians), and zoom. */
  yaw: number; pitch: number; zoom: number;
  /** 1 while the formed visual is a 3D object (depth cue, no ripple), else 0. */
  depth: number;
}

export interface OrbitCommand {
  rotate?: "left" | "right" | "up" | "down";
  /** How far a rotate turns (degrees, default 45). */
  degrees?: number;
  zoom?: "in" | "out";
  /** Resume (true) or stop (false) the slow turn. */
  spin?: boolean;
  reset?: boolean;
}

export const ORBIT = {
  /** The view a new object first forms in: a little turned, so its depth reads at once. */
  yaw: 0.55,
  /** Slow turn (rad/s) and the pause after an interaction before it resumes (s). */
  spin: 0.28, resume: 3,
  pitch: { min: -1.2, max: 1.2 },
  zoom: { min: 0.6, max: 1.8 },
  /** Drag sensitivity (radians per pixel). */
  drag: 0.009,
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const approach = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));

export class OrbitController {
  active = false;
  yaw = ORBIT.yaw; pitch = 0; zoom = 1;
  /** The slow turn's speed for the current object (rad/s; 0: still) and whether it is turning now. */
  spinRate = ORBIT.spin;
  spinning = true;
  private tilt = 0;
  private goal = { yaw: ORBIT.yaw, pitch: 0, zoom: 1 };
  private velocity = 0;
  private idle = Infinity;
  private dragging: { x: number; y: number; id: number } | null = null;

  /** A new 3D object: its own default view. */
  reset(motion: { orbit?: number; tilt?: number } = {}) {
    this.tilt = clamp(motion.tilt ?? 0.25, ORBIT.pitch.min, ORBIT.pitch.max);
    this.spinRate = motion.orbit ?? ORBIT.spin;
    this.yaw = this.goal.yaw = ORBIT.yaw;
    this.pitch = this.goal.pitch = this.tilt;
    this.zoom = this.goal.zoom = 1;
    this.velocity = 0; this.idle = Infinity; this.spinning = this.spinRate > 0;
  }

  /** Back to the default view, eased (the slow turn resumes). */
  home() { this.goal = { yaw: this.yaw + ((ORBIT.yaw - this.yaw) % (Math.PI * 2)), pitch: this.tilt, zoom: 1 }; this.spinning = this.spinRate > 0; this.idle = 0; }

  command(command: OrbitCommand) {
    if (command.reset) { this.home(); return; }
    const step = clamp(command.degrees ?? 45, 5, 180) * Math.PI / 180;
    if (command.rotate === "left") this.goal.yaw -= step;
    if (command.rotate === "right") this.goal.yaw += step;
    if (command.rotate === "up") this.goal.pitch = clamp(this.goal.pitch + step, ORBIT.pitch.min, ORBIT.pitch.max);
    if (command.rotate === "down") this.goal.pitch = clamp(this.goal.pitch - step, ORBIT.pitch.min, ORBIT.pitch.max);
    if (command.zoom) this.goal.zoom = clamp(this.goal.zoom * (command.zoom === "in" ? 1.3 : 1 / 1.3), ORBIT.zoom.min, ORBIT.zoom.max);
    if (command.spin === true) { if (this.spinRate <= 0) this.spinRate = ORBIT.spin; this.spinning = true; }
    if (command.spin === false) this.spinning = false;
    this.idle = 0;
  }

  /** Dragging turns (horizontal) and tilts (vertical) the object directly; releasing keeps a little momentum. */
  dragBy(dx: number, dy: number, dt = 1 / 60) {
    const turn = dx * ORBIT.drag;
    this.goal.yaw += turn; this.yaw += turn;
    this.goal.pitch = this.pitch = clamp(this.pitch + dy * ORBIT.drag * 0.8, ORBIT.pitch.min, ORBIT.pitch.max);
    this.velocity = dt > 0 ? turn / Math.max(dt, 1 / 120) : 0;
    this.idle = 0;
  }

  zoomBy(factor: number) { this.goal.zoom = clamp(this.goal.zoom * factor, ORBIT.zoom.min, ORBIT.zoom.max); this.idle = 0; }

  sample(dt: number): OrbitView {
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    if (!this.active) return { yaw: this.yaw, pitch: this.pitch, zoom: this.zoom, depth: 0 };
    this.idle += step;
    if (!this.dragging) {
      // Momentum after a drag, then the slow turn once the user has left it alone for a moment.
      this.goal.yaw += this.velocity * step;
      this.velocity *= Math.exp(-3 * step);
      if (this.spinning && this.idle > ORBIT.resume) this.goal.yaw += this.spinRate * step * Math.min(1, (this.idle - ORBIT.resume) / 1.5);
    }
    this.yaw = approach(this.yaw, this.goal.yaw, 5, step);
    this.pitch = approach(this.pitch, this.goal.pitch, 5, step);
    this.zoom = approach(this.zoom, this.goal.zoom, 6, step);
    return { yaw: this.yaw, pitch: this.pitch, zoom: this.zoom, depth: 1 };
  }

  /** Pointer and wheel handling on the stage, only while a 3D object is formed. Returns a detach function. */
  attach(element: HTMLElement): () => void {
    let last = 0;
    const down = (event: PointerEvent) => {
      if (!this.active || event.button !== 0) return;
      this.dragging = { x: event.clientX, y: event.clientY, id: event.pointerId };
      last = event.timeStamp; this.velocity = 0;
      element.setPointerCapture?.(event.pointerId);
      element.style.cursor = "grabbing";
    };
    const move = (event: PointerEvent) => {
      if (!this.dragging || event.pointerId !== this.dragging.id) { element.style.cursor = this.active ? "grab" : ""; return; }
      const dt = (event.timeStamp - last) / 1000; last = event.timeStamp;
      this.dragBy(event.clientX - this.dragging.x, event.clientY - this.dragging.y, dt);
      this.dragging.x = event.clientX; this.dragging.y = event.clientY;
    };
    const up = (event: PointerEvent) => {
      if (this.dragging?.id !== event.pointerId) return;
      this.dragging = null;
      element.style.cursor = this.active ? "grab" : "";
    };
    const wheel = (event: WheelEvent) => {
      if (!this.active) return;
      event.preventDefault();
      this.zoomBy(Math.exp(-clamp(event.deltaY, -200, 200) * 0.0015));
    };
    const double = () => { if (this.active) this.home(); };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("dblclick", double);
    return () => {
      element.removeEventListener("pointerdown", down); element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up); element.removeEventListener("pointercancel", up);
      element.removeEventListener("wheel", wheel); element.removeEventListener("dblclick", double);
    };
  }
}
