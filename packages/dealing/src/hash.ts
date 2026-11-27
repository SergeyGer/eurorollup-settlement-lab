/**
 * Canonical JSON and SHA-256 hashing.
 *
 * Canonical form: object keys sorted by UTF-16 code unit order, arrays kept in
 * their given order, no insignificant whitespace, UTF-8 bytes. This is the
 * representation hashed into every business digest and evidence checksum.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { DealingError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DealingError(
        "HASH_INPUT_UNSUPPORTED",
        `Non-finite number at ${path} cannot be hashed canonically`,
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => canonicalize(item, `${path}[${index}]`));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => {
      const item = record[key];
      if (item === undefined) {
        throw new DealingError(
          "HASH_INPUT_UNSUPPORTED",
          `undefined value at ${path}.${key} cannot be hashed canonically`,
        );
      }
      return `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new DealingError(
    "HASH_INPUT_UNSUPPORTED",
    `Unsupported value of type ${typeof value} at ${path}`,
  );
}

/** Returns the canonical JSON text for a value. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$");
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  return bytesToHex(sha256(bytes));
}

/** SHA-256 of the canonical JSON form of a value. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
