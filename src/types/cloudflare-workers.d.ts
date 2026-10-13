// Minimal ambient types for the Workers runtime module; @cloudflare/workers-types is not installed.
declare module "cloudflare:workers" {
  /** Extend the current request's lifetime until `promise` settles. */
  export function waitUntil(promise: Promise<unknown>): void;
}
