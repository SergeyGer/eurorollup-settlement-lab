import { describe, expect, it } from "vitest";
import {
  checkRateFreshness,
  ethToEurMicros,
  evaluateCostExperiment,
  evaluatePermit,
  reconcileBundle,
  reconcileOperatorEconomics,
  runScenarioMatrix,
  type BundleMeasurement,
  type CostExperimentInputs,
  type RateObservation,
} from "../src/index.js";

const RATE: RateObservation = {
  pair: "EUR/ETH",
  rateEurPerEth: "3200.50",
  rateMicrosPerEth: 3_200_500_000n,
  observedAt: "2024-01-05T12:00:00.000Z",
  source: "demo-fixture",
  maxAgeSeconds: 60,
};

const observedAtSeconds = Math.floor(Date.parse(RATE.observedAt) / 1000);

function measurement(overrides: Partial<BundleMeasurement> = {}): BundleMeasurement {
  return {
    outerGasUsed: 250_000n,
    effectiveGasPriceWei: 2_000_000_000n,
    l1DataFeeWei: 1_200_000_000_000_000n,
    operatorFeeWei: 100_000_000_000_000n,
    paymasterDepositDeltaWei: -700_000_000_000_000n,
    beneficiaryDeltaWei: 650_000_000_000_000n,
    investorChargeEurMicros: 50_000n,
    rate: RATE,
    rateObservedNowEpochSeconds: observedAtSeconds + 10,
    dataMode: "measured",
    ops: [
      { opId: "op-1", actualGasUsed: 120_000n, actualGasCostWei: 400_000_000_000_000n, success: true, userChargeWei: 0n },
      { opId: "op-2", actualGasUsed: 80_000n, actualGasCostWei: 300_000_000_000_000n, success: false, userChargeWei: 0n },
    ],
    ...overrides,
  };
}

describe("rate observation", () => {
  it("rejects a stale rate", () => {
    const fresh = checkRateFreshness(RATE, observedAtSeconds + 30);
    expect(fresh.usable).toBe(true);
    const stale = checkRateFreshness(RATE, observedAtSeconds + 61);
    expect(stale.usable).toBe(false);
    expect(stale.reason).toContain("older than 60");
  });

  it("converts wei to micro-euro deterministically", () => {
    expect(ethToEurMicros(1_000_000_000_000_000_000n, 3_200_500_000n)).toBe(3_200_500_000n);
    expect(ethToEurMicros(500_000_000_000_000n, 3_200_500_000n)).toBe(1_600_250n);
  });
});

describe("bundle reconciliation", () => {
  it("allocates the measured bundle total and reproduces it exactly", () => {
    const result = reconcileBundle(measurement());
    expect(result.bundleTotalWei).toBe(700_000_000_000_000n);
    expect(result.invariants.allocationsPlusResidualEqualsTotal).toBe(true);
    expect(result.allocations.reduce((sum, entry) => sum + entry.allocWei, 0n)).toBe(700_000_000_000_000n);
    expect(result.failedAllocWei).toBeGreaterThan(0n);
    expect(result.invariants.investorChargeIsExplicitLeg).toBe(true);
  });

  it("marks unavailable fee components instead of inventing them", () => {
    const result = reconcileBundle(measurement({ l1DataFeeWei: null, operatorFeeWei: null }));
    expect(result.unavailable).toContain("l1DataFeeWei");
    expect(result.unavailable).toContain("operatorFeeWei");
    expect(result.l1DataFeeWei).toBeNull();
    expect(result.networkCostWei).toBe(result.executionFeeWei);
    expect(result.invariants.reconciliationItemsSumToSponsorPaidDifference).toBe(true);
  });

  it("returns null sponsor contribution when the rate is stale", () => {
    const result = reconcileBundle(measurement({ rateObservedNowEpochSeconds: observedAtSeconds + 120 }));
    expect(result.sponsorCostEurMicros).toBeNull();
    expect(result.sponsorContributionEurMicros).toBeNull();
    expect(result.unavailable.some((entry) => entry.includes("rate"))).toBe(true);
  });

  it("names reconciliation differences instead of hiding them", () => {
    const result = reconcileBundle(measurement());
    const names = result.reconciliationItems.map((item) => item.name);
    expect(names).toContain("networkCostVsSponsorPaid");
    expect(names).toContain("sponsorPaidVsBundlerRevenue");
    expect(result.invariants.reconciliationItemsSumToSponsorPaidDifference).toBe(true);
  });
});

describe("cost experiment", () => {
  const base: CostExperimentInputs = {
    dailyOrders: 1_000,
    eligibleSponsorShareBps: 4_000,
    rate: RATE,
    rateAgeSeconds: 10,
    daPriceWeiPerByte: 1_000_000_000n,
    batchUtilizationBps: 8_000,
    perOrderExecutionGas: 150_000n,
    l1DataBytesPerOrder: 200n,
    gasPriceWei: 1_000_000n,
    investorChargeEurMicros: 50_000n,
    dailyBudgetEurMicros: 1_000_000n,
  };

  it("prices a scenario deterministically", () => {
    const result = evaluateCostExperiment(base);
    expect(result.perOrderSponsorCostWei).not.toBeNull();
    expect(result.perOrderSponsorCostWei).toBe(400_000_000_000n);
    expect(result.unavailable).toHaveLength(0);
  });

  it("reports unavailable inputs instead of zero", () => {
    const result = evaluateCostExperiment({ ...base, daPriceWeiPerByte: null });
    expect(result.perOrderSponsorCostWei).toBeNull();
    expect(result.sponsorContributionPerOrderEurMicros).toBeNull();
    expect(result.unavailable).toContain("daPriceWeiPerByte");
  });

  it("finds the first exhausting order count", () => {
    const result = evaluateCostExperiment({ ...base, investorChargeEurMicros: 100n, dailyBudgetEurMicros: 1n });
    expect(result.firstExhaustingDailyOrders).not.toBeNull();
    expect(result.firstExhaustingDailyOrders).toBeGreaterThan(0);
  });

  it("finds a sustainable investor charge", () => {
    const result = evaluateCostExperiment(base);
    expect(result.firstSustainableChargeEurMicros).not.toBeNull();
    expect(result.firstSustainableChargeEurMicros).toBe(result.perOrderSponsorCostEurMicros);
    expect(result.sponsorContributionPerOrderEurMicros).toBe(50_000n - result.perOrderSponsorCostEurMicros!);
  });

  it("produces a scenario matrix with a default and edited cases", () => {
    const scenarios = runScenarioMatrix(base, [
      { scenarioId: "default", description: "recorded defaults", patch: {} },
      { scenarioId: "cheap-da", description: "halved DA price", patch: { daPriceWeiPerByte: 500_000_000n } },
    ]);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[1]!.result.perOrderSponsorCostWei!).toBeLessThan(scenarios[0]!.result.perOrderSponsorCostWei!);
  });
});

describe("funding guard", () => {
  const request = {
    amountWei: 100n,
    perOperationCapWei: 200n,
    dailyBudgetWei: 1_000n,
    alreadySpentTodayWei: 300n,
    outstandingReservationsWei: 200n,
    nativeDepositWei: 1_000n,
    configuredReserveWei: 100n,
    rateAgeSeconds: 10,
    maxRateAgeSeconds: 60,
    fundEscrowWei: 5_000n,
  };

  it("approves a request that satisfies all checks", () => {
    const evaluation = evaluatePermit(request);
    expect(evaluation.decision).toBe("approve");
    expect(evaluation.reservationWei).toBe(100n);
  });

  it("rejects a stale rate and preserves reservations and escrow visibility", () => {
    const evaluation = evaluatePermit({ ...request, rateAgeSeconds: 61 });
    expect(evaluation.reason).toBe("stale-rate");
    expect(evaluation.outstandingReservationsPreservedWei).toBe(200n);
    expect(evaluation.fundEscrowVisibleWei).toBe(5_000n);
    expect(evaluation.sponsorshipPaused).toBe(true);
  });

  it("rejects when the per-operation cap or the daily budget is exceeded", () => {
    expect(evaluatePermit({ ...request, amountWei: 201n }).reason).toBe("per-operation-cap-exceeded");
    expect(evaluatePermit({ ...request, alreadySpentTodayWei: 800n }).reason).toBe("daily-budget-exceeded");
  });

  it("rejects when the native deposit falls below the reserve", () => {
    expect(evaluatePermit({ ...request, nativeDepositWei: 150n }).reason).toBe("deposit-below-reserve");
  });
});

describe("chain operator economics", () => {
  it("counts each flow once and reports infrastructure separately", () => {
    const result = reconcileOperatorEconomics({
      windowStartBlock: 100,
      windowEndBlock: 200,
      feeVaultInflowWei: 1_000n,
      batcherOutflowWei: 600n,
      infrastructureSpendWei: 50n,
      batcherTxHashes: ["0xaa", "0xbb"],
    });
    expect(result.netProtocolWei).toBe(400n);
    expect(result.netAfterInfrastructureWei).toBe(350n);
    expect(result.duplicateFlowsDetected).toBe(false);
    expect(result.countedFlows).toHaveLength(2);
  });

  it("flags duplicate flow identifiers instead of double counting", () => {
    const result = reconcileOperatorEconomics({
      windowStartBlock: 100,
      windowEndBlock: 200,
      feeVaultInflowWei: 1_000n,
      batcherOutflowWei: 600n,
      infrastructureSpendWei: 0n,
      batcherTxHashes: ["0xAA", "0xaa"],
    });
    expect(result.duplicateFlowsDetected).toBe(true);
    expect(result.notes.some((note) => note.includes("duplicate"))).toBe(true);
  });
});
