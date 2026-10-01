import type { RuntimeHandle, RuntimeInputs, RuntimeOptions } from "./ParticleRuntime";

export type { Framing, FramingSource, RuntimeHandle, RuntimeInputs, RuntimeOptions, QualityReport } from "./ParticleRuntime";
export type RendererBackend = RuntimeHandle["backend"];

/** Where each renderer comes from; injectable so the selection is testable without a GPU or a DOM. */
export interface RendererFactories {
  webgpu(container: HTMLElement, inputs: RuntimeInputs, lifetime: AbortSignal, onError: (code: string) => void, options: RuntimeOptions): Promise<RuntimeHandle | undefined>;
  canvas(container: HTMLElement, inputs: RuntimeInputs, lifetime: AbortSignal, options: RuntimeOptions): RuntimeHandle;
}

export interface RendererResult {
  handle: RuntimeHandle | undefined;
  /** Why the WebGPU body is not used, when it is not ("webgpu-unavailable", "webgpu-failed", "forced"). */
  fallbackReason: string | null;
}

/**
 * Starts the particle body: the WebGPU renderer when the browser (or the host's iframe) supports it, and the
 * canvas renderer otherwise, so the Presence always appears. `prefer: "canvas"` forces the fallback (testing,
 * or a host known to block WebGPU). A WebGPU device lost later is reported through `onError` and also falls
 * back, once: `onError` then receives the replacement handle.
 */
export async function createRenderer(
  container: HTMLElement, inputs: RuntimeInputs, lifetime: AbortSignal, onError: (code: string, replacement?: RuntimeHandle) => void,
  options: RuntimeOptions & { prefer?: RendererBackend } = {}, factories?: RendererFactories,
): Promise<RendererResult> {
  const make = factories ?? await defaultFactories();
  const fallback = (reason: string): RendererResult => ({ handle: lifetime.aborted ? undefined : make.canvas(container, inputs, lifetime, options), fallbackReason: reason });
  if (options.prefer === "canvas") return fallback("forced");
  try {
    let current: RuntimeHandle | undefined;
    const lost = (code: string) => {
      if (code === "device-lost" && !lifetime.aborted && current?.backend === "webgpu") {
        current = make.canvas(container, inputs, lifetime, options);
        onError(code, current);
      } else onError(code);
    };
    current = await make.webgpu(container, inputs, lifetime, lost, options);
    return { handle: current, fallbackReason: null };
  } catch (error) {
    const reason = error instanceof Error && /^webgpu-[a-z-]+$/.test(error.message) ? error.message : "webgpu-failed";
    return fallback(reason);
  }
}

async function defaultFactories(): Promise<RendererFactories> {
  const [{ createParticleRuntime }, { createCanvasRuntime }] = await Promise.all([import("./ParticleRuntime"), import("./fallback/canvasRuntime")]);
  return { webgpu: createParticleRuntime, canvas: createCanvasRuntime };
}
