/**
 * Integer base-unit money arithmetic.
 *
 * Rules (specification, sections 03 and 08):
 * - amounts are integer base units; never floating point;
 * - external serialization uses decimal strings;
 * - issued units round down and residual cash returns to the investor;
 * - a zero-unit fill is rejected.
 */
import { DealingError } from "./errors.js";

/** Fixed investor charge for a successful spot fill: EUR 0.05 in dEUR base units. */
export const SPOT_INVESTOR_CHARGE_BASE = 50_000n;

/** EUR price marks are expressed with 6 decimals, like the cash asset. */
export const PRICE_DECIMALS = 6;

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
const BASE_UNIT_RE = /^-?\d+$/;

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 36) {
    throw new DealingError(
      "INVALID_AMOUNT",
      `Unsupported decimal exponent: ${String(exponent)}`,
    );
  }
  return 10n ** BigInt(exponent);
}

/** Parses a canonical base-unit integer string (e.g. "300000000"). */
export function parseBaseUnits(value: string | bigint): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (!BASE_UNIT_RE.test(value)) {
    throw new DealingError(
      "INVALID_AMOUNT",
      `Invalid base-unit integer string: ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

/** Serializes base units as a canonical integer string. */
export function serializeBaseUnits(value: bigint): string {
  return value.toString();
}

/** Parses a human decimal string into base units with the given decimals. */
export function parseDecimalToBase(value: string, decimals: number): bigint {
  if (!DECIMAL_RE.test(value)) {
    throw new DealingError(
      "INVALID_AMOUNT",
      `Invalid decimal string: ${JSON.stringify(value)}`,
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new DealingError(
      "INVALID_AMOUNT",
      `Invalid decimals: ${String(decimals)}`,
    );
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > decimals) {
    throw new DealingError(
      "PRECISION_EXCEEDED",
      `Value ${value} has more than ${decimals} decimal places`,
    );
  }
  const padded = fraction.padEnd(decimals, "0");
  const base = BigInt(whole + padded);
  return negative ? -base : base;
}

/** Formats base units as an exact minimal decimal string (e.g. "3.125"). */
export function formatBaseAsDecimal(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new DealingError(
      "INVALID_AMOUNT",
      `Invalid decimals: ${String(decimals)}`,
    );
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  if (decimals === 0) {
    return (negative ? "-" : "") + absolute.toString();
  }
  const scale = pow10(decimals);
  const whole = absolute / scale;
  const fraction = absolute % scale;
  if (fraction === 0n) {
    return (negative ? "-" : "") + whole.toString();
  }
  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fractionText}`;
}

/**
 * Formats base units for display with a fixed number of fraction digits,
 * truncating (not rounding) any finer precision. Display only: evidence keeps
 * exact base units.
 */
export function formatDisplayAmount(
  value: bigint,
  decimals: number,
  displayDecimals: number,
): string {
  if (displayDecimals > decimals) {
    return formatBaseAsDecimal(value, decimals) + "0".repeat(displayDecimals - decimals);
  }
  const step = pow10(decimals - displayDecimals);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const truncated = absolute / step;
  const whole = displayDecimals === 0 ? truncated : truncated / pow10(displayDecimals);
  const fraction = displayDecimals === 0 ? 0n : truncated % pow10(displayDecimals);
  const fractionText =
    displayDecimals === 0 ? "" : `.${fraction.toString().padStart(displayDecimals, "0")}`;
  return `${negative ? "-" : ""}${whole.toString()}${fractionText}`;
}

/** Floor division that behaves correctly for negative values. */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new DealingError("INVALID_AMOUNT", "Division by zero");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n && (remainder > 0n) !== (denominator > 0n)) {
    return quotient - 1n;
  }
  return quotient;
}

/** Ceiling division that behaves correctly for negative values. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  const floored = floorDiv(numerator, denominator);
  return floored * denominator === numerator ? floored : floored + 1n;
}

/**
 * Computes floor(value * 10^numeratorScale / (denominator * 10^denominatorScale)).
 * Generic rational helper used by every unit and cash conversion.
 */
export function scaleDivFloor(
  value: bigint,
  numeratorScale: number,
  denominator: bigint,
  denominatorScale: number,
): bigint {
  const netScale = numeratorScale - denominatorScale;
  if (netScale >= 0) {
    return floorDiv(value * pow10(netScale), denominator);
  }
  return floorDiv(value, denominator * pow10(-netScale));
}

/**
 * Converts a cash amount into a quantity of an instrument, rounding down.
 *
 * unitsBase = floor(amountBase / priceBase * 10^resultDecimals adjusted for
 * decimals), where priceBase is the EUR price of one whole unit.
 */
export function quoteUnits(params: {
  amountBase: bigint;
  amountDecimals: number;
  priceBase: bigint;
  priceDecimals: number;
  resultDecimals: number;
}): bigint {
  if (params.priceBase <= 0n) {
    throw new DealingError("INVALID_AMOUNT", "Price must be positive");
  }
  if (params.amountBase <= 0n) {
    return 0n;
  }
  return scaleDivFloor(
    params.amountBase,
    params.priceDecimals + params.resultDecimals,
    params.priceBase,
    params.amountDecimals,
  );
}

/**
 * Converts a quantity of an instrument into a cash amount at a EUR price,
 * rounding down.
 */
export function quoteCash(params: {
  unitsBase: bigint;
  unitDecimals: number;
  priceBase: bigint;
  priceDecimals: number;
  cashDecimals: number;
}): bigint {
  if (params.priceBase < 0n) {
    throw new DealingError("INVALID_AMOUNT", "Price must not be negative");
  }
  if (params.unitsBase <= 0n) {
    return 0n;
  }
  return scaleDivFloor(
    params.unitsBase * params.priceBase,
    params.cashDecimals,
    pow10(params.unitDecimals + params.priceDecimals),
    0,
  );
}

export interface FundAllocation {
  readonly unitsBase: bigint;
  readonly cashConsumedBase: bigint;
  readonly residualCashBase: bigint;
}

/**
 * Computes the fund allocation for a reserved cash amount at an authorized NAV.
 * Units round down; the residual cash is returned to the investor.
 */
export function allocateCashToUnits(params: {
  cashBase: bigint;
  cashDecimals: number;
  navBase: bigint;
  navDecimals: number;
  unitDecimals: number;
}): FundAllocation {
  if (params.navBase <= 0n) {
    throw new DealingError("INVALID_AMOUNT", "NAV must be positive");
  }
  if (params.cashBase <= 0n) {
    throw new DealingError("NEGATIVE_AMOUNT", "Reserved cash must be positive");
  }
  const unitsBase = quoteUnits({
    amountBase: params.cashBase,
    amountDecimals: params.cashDecimals,
    priceBase: params.navBase,
    priceDecimals: params.navDecimals,
    resultDecimals: params.unitDecimals,
  });
  if (unitsBase === 0n) {
    throw new DealingError("ZERO_UNIT_FILL", "Allocation would issue zero units", {
      cashBase: params.cashBase.toString(),
      navBase: params.navBase.toString(),
    });
  }
  const cashConsumedBase = quoteCash({
    unitsBase,
    unitDecimals: params.unitDecimals,
    priceBase: params.navBase,
    priceDecimals: params.navDecimals,
    cashDecimals: params.cashDecimals,
  });
  const residualCashBase = params.cashBase - cashConsumedBase;
  if (residualCashBase < 0n) {
    throw new DealingError("JOURNAL_IMBALANCE", "Allocation consumed more cash than reserved");
  }
  return { unitsBase, cashConsumedBase, residualCashBase };
}

/** Adds two base-unit amounts after parsing serialized input. */
export function addBase(a: string | bigint, b: string | bigint): bigint {
  return parseBaseUnits(a) + parseBaseUnits(b);
}

export function isZero(value: bigint): boolean {
  return value === 0n;
}

export function assertPositive(value: bigint, field: string): void {
  if (value <= 0n) {
    throw new DealingError("NEGATIVE_AMOUNT", `${field} must be positive`, {
      value: value.toString(),
    });
  }
}

/** Compares a serialized decimal price with base units, used by fixtures. */
export function priceFromDecimal(value: string): bigint {
  return parseDecimalToBase(value, PRICE_DECIMALS);
}
