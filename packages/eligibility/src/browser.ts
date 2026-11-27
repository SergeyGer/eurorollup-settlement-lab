/**
 * Browser-safe eligibility entry point.
 *
 * Excludes the proving backend: the browser loads the prover lazily through
 * `@eurorollup/eligibility/prover` only when a visitor asks for a proof.
 */
export * from "./types.js";
export * from "./fixtures.js";
export * from "./policy.js";
export * from "./receipt.js";
