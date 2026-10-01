/** A failure with a stable, model-safe code (e.g. "image-not-found", "region-not-found"). From SCF's resolver. */
export class ResolveError extends Error {
  constructor(code: string) { super(code); this.name = "ResolveError"; }
}

/** The error's code when it is a short, safe one; otherwise "error". */
export const errorCode = (error: unknown) => error instanceof Error && /^[a-z0-9][a-z0-9-]{0,39}$/.test(error.message) ? error.message : "error";
