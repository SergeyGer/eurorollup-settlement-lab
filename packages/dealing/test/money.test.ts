import { describe, expect, it } from "vitest";
import {
  DealingError,
  SPOT_INVESTOR_CHARGE_BASE,
  allocateCashToUnits,
  formatBaseAsDecimal,
  formatDisplayAmount,
  parseDecimalToBase,
  parseBaseUnits,
  quoteCash,
  quoteUnits,
} from "../src/index.js";

describe("integer base-unit money", () => {
  it("parses and serializes decimal strings without floating point", () => {
    expect(parseDecimalToBase("799.95", 6)).toBe(799_950_000n);
    expect(parseDecimalToBase("1000", 6)).toBe(1_000_000_000n);
    expect(parseDecimalToBase("-0.05", 6)).toBe(-50_000n);
    expect(formatBaseAsDecimal(799_950_000n, 6)).toBe("799.95");
    expect(formatBaseAsDecimal(3_125_000n, 6)).toBe("3.125");
    expect(formatBaseAsDecimal(1n, 18)).toBe("0.000000000000000001");
  });

  it("rejects over-precision and malformed amounts", () => {
    expect(() => parseDecimalToBase("1.1234567", 6)).toThrowError(DealingError);
    expect(() => parseDecimalToBase("1,000.00", 6)).toThrowError(DealingError);
    expect(() => parseDecimalToBase("abc", 6)).toThrowError(DealingError);
  });

  it("formats display amounts with truncated precision", () => {
    expect(formatDisplayAmount(799_950_000n, 6, 2)).toBe("799.95");
    expect(formatDisplayAmount(100_000_000_000_000_000n, 18, 6)).toBe("0.100000");
    expect(formatDisplayAmount(3_125_000n, 6, 6)).toBe("3.125000");
  });

  it("applies the G01 spot conversion exactly", () => {
    const units = quoteUnits({
      amountBase: 200_000_000n,
      amountDecimals: 6,
      priceBase: 2_000_000_000n,
      priceDecimals: 6,
      resultDecimals: 18,
    });
    expect(units).toBe(100_000_000_000_000_000n);
    expect(SPOT_INVESTOR_CHARGE_BASE).toBe(50_000n);
  });

  it("rounds issued units down and returns residual cash", () => {
    const allocation = allocateCashToUnits({
      cashBase: 300_000_000n,
      cashDecimals: 6,
      navBase: 96_000_000n,
      navDecimals: 6,
      unitDecimals: 6,
    });
    expect(allocation.unitsBase).toBe(3_125_000n);
    expect(allocation.cashConsumedBase).toBe(300_000_000n);
    expect(allocation.residualCashBase).toBe(0n);
  });

  it("returns dust to the investor instead of retaining it", () => {
    const allocation = allocateCashToUnits({
      cashBase: 100_000_000n,
      cashDecimals: 6,
      navBase: 96_000_000n,
      navDecimals: 6,
      unitDecimals: 6,
    });
    expect(allocation.unitsBase).toBe(1_041_666n);
    expect(allocation.residualCashBase).toBe(64n);
    expect(allocation.cashConsumedBase + allocation.residualCashBase).toBe(100_000_000n);
  });

  it("rejects a zero-unit fill", () => {
    expect(() =>
      allocateCashToUnits({
        cashBase: 1n,
        cashDecimals: 6,
        navBase: 96_000_000n,
        navDecimals: 6,
        unitDecimals: 6,
      }),
    ).toThrowError(DealingError);
  });

  it("converts units back to cash at a NAV", () => {
    expect(
      quoteCash({
        unitsBase: 1_000_000n,
        unitDecimals: 6,
        priceBase: 98_000_000n,
        priceDecimals: 6,
        cashDecimals: 6,
      }),
    ).toBe(98_000_000n);
  });

  it("parses base units strictly", () => {
    expect(parseBaseUnits("300000000")).toBe(300_000_000n);
    expect(() => parseBaseUnits("300.00")).toThrowError(DealingError);
  });
});

describe("money guard rails", () => {
  it("keeps a stable investor charge constant", () => {
    expect(SPOT_INVESTOR_CHARGE_BASE.toString()).toBe("50000");
  });
});
