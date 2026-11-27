/** Identifier factories. Evidence runs use the sequential factory for determinism. */
import { randomUUID } from "node:crypto";

export interface IdFactory {
  quote(): string;
  order(): string;
  trace(): string;
}

export function randomIdFactory(): IdFactory {
  return {
    quote: () => `quote_${randomUUID()}`,
    order: () => `order_${randomUUID()}`,
    trace: () => `trace_${randomUUID()}`,
  };
}

/** Deterministic ids for evidence packs: quote_0001, order_0001, trace_0001. */
export function sequentialIdFactory(): IdFactory {
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}_${counter.toString().padStart(4, "0")}`;
  };
  return {
    quote: () => next("quote"),
    order: () => next("order"),
    trace: () => next("trace"),
  };
}
