/** Deterministic id factory for the demo quickstart output. */
import type { IdFactory } from "../src/ids.js";

export function createIdFactoryForDemo(): IdFactory {
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}_demo_${counter.toString().padStart(3, "0")}`;
  };
  return {
    quote: () => next("quote"),
    order: () => next("order"),
    trace: () => next("trace"),
    scenario: () => next("scenario"),
    run: () => next("run"),
  };
}
