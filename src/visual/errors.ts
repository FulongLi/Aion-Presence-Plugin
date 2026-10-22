/** A failure with a stable, model-safe code (e.g. "image-not-found", "region-not-found"). From SCF's resolver. */
export class ResolveError extends Error {
  /** v0.5.2: the underlying short code behind a family failure (e.g. `timeout`, `http-503`, `terrain-tile-invalid`). */
  readonly detail?: string;
  constructor(code: string, detail?: string) { super(code); this.name = "ResolveError"; if (detail && detail !== code) this.detail = detail; }
}

/** The underlying cause of a ResolveError, when it carries one. */
export const errorDetail = (error: unknown) => error instanceof ResolveError ? error.detail : undefined;

/** The error's code when it is a short, safe one; otherwise "error". */
export const errorCode = (error: unknown) => error instanceof Error && /^[a-z0-9][a-z0-9-]{0,39}$/.test(error.message) ? error.message : "error";
