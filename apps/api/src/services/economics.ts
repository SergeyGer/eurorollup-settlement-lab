/**
 * Economics and operations reads for the partner API.
 *
 * The observed bundle, the cost-experiment defaults and the drill dashboard are
 * committed evidence artifacts. This service reads them from the repository at
 * request time (they are versioned inputs in this local lab) and evaluates
 * user-supplied scenarios with the deterministic `@eurorollup/economics` package.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCostExperiment,
  type CostExperimentInputs,
  type RateObservation,
} from "@eurorollup/economics";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as T;
}

export interface ObservedEconomics {
  readonly bundle: {
    readonly outerTxHash: string;
    readonly outerStatus: number;
    readonly sponsorPaidWei: string;
    readonly bundlerRevenueWei: string;
    readonly bundleTotalWei: string;
    readonly networkCostWei: string;
    readonly unavailable: readonly string[];
    readonly operations: ReadonlyArray<{ readonly opId: string; readonly success: boolean; readonly actualGasUsed: string; readonly actualGasCostWei: string }>;
  };
  readonly reconciliation: {
    readonly allocations: ReadonlyArray<{ readonly bucket: string; readonly allocWei: string }>;
    readonly residualWei: string;
    readonly failedAllocWei: string;
    readonly invariants: Record<string, boolean>;
  };
  readonly charges: {
    readonly investorChargeEurMicros: string;
    readonly sponsorCostEurMicros: string | null;
    readonly sponsorContributionEurMicros: string | null;
  };
  readonly observedDefaults: Record<string, unknown> | null;
  readonly scenarioInputs: Record<string, unknown>;
}

export function readObservedEconomics(): ObservedEconomics {
  const bundle = readJson<Record<string, any>>("evidence/a07/bundle-reconciliation.json");
  const experiment = readJson<Record<string, any>>("benchmarks/cost-experiment.json");
  return {
    bundle: {
      outerTxHash: bundle.bundle.outerTxHash,
      outerStatus: bundle.bundle.outerStatus,
      sponsorPaidWei: bundle.bundle.sponsorPaidWei,
      bundlerRevenueWei: bundle.bundle.bundlerRevenueWei,
      bundleTotalWei: bundle.bundle.bundleTotalWei,
      networkCostWei: bundle.bundle.networkCostWei,
      unavailable: bundle.unavailable,
      operations: bundle.bundle.operations.map((operation: Record<string, unknown>) => ({
        opId: operation.opId,
        success: operation.success,
        actualGasUsed: operation.actualGasUsed,
        actualGasCostWei: operation.actualGasCostWei,
      })),
    },
    reconciliation: {
      allocations: bundle.reconciliation.allocations.map((allocation: Record<string, unknown>) => ({
        bucket: allocation.bucket,
        allocWei: allocation.allocWei,
      })),
      residualWei: bundle.reconciliation.residualWei,
      failedAllocWei: bundle.reconciliation.failedAllocWei,
      invariants: bundle.reconciliation.invariants,
    },
    charges: {
      investorChargeEurMicros: bundle.charges.investorChargeEurMicros,
      sponsorCostEurMicros: bundle.charges.sponsorCostEurMicros,
      sponsorContributionEurMicros: bundle.charges.sponsorContributionEurMicros,
    },
    observedDefaults: (experiment.observedDefaults as Record<string, unknown> | undefined) ?? null,
    scenarioInputs: experiment.scenarioInputs as Record<string, unknown>,
  };
}

export interface ScenarioBody {
  readonly dailyOrders: number;
  readonly eligibleSponsorShareBps: number;
  readonly daPriceWeiPerByte: string | null;
  readonly batchUtilizationBps: number;
  readonly investorChargeEurMicros: string;
  readonly dailyBudgetEurMicros: string | null;
  readonly rateAgeSeconds: number;
}

export interface ScenarioResult {
  readonly inputs: Record<string, string | number | null>;
  readonly result: Record<string, string | number | boolean | null | readonly string[]>;
  readonly dataMode: "scenario";
}

const rateFixture = readJson<Record<string, unknown>>("fixtures/economics/rate.json");
const costFixture = readJson<Record<string, unknown>>("fixtures/economics/cost-inputs.json");
const RATE: RateObservation = {
  pair: "EUR/ETH",
  rateEurPerEth: String(rateFixture["rateEurPerEth"]),
  rateMicrosPerEth: BigInt(String(rateFixture["rateMicrosPerEth"])),
  observedAt: String(rateFixture["observedAt"]),
  source: "demo-fixture",
  maxAgeSeconds: Number(rateFixture["maxAgeSeconds"]),
};

export function evaluateScenario(body: ScenarioBody): ScenarioResult {
  const inputs: CostExperimentInputs = {
    dailyOrders: body.dailyOrders,
    eligibleSponsorShareBps: body.eligibleSponsorShareBps,
    rate: RATE,
    rateAgeSeconds: body.rateAgeSeconds,
    daPriceWeiPerByte: body.daPriceWeiPerByte === null ? null : BigInt(body.daPriceWeiPerByte),
    batchUtilizationBps: body.batchUtilizationBps,
    perOrderExecutionGas: BigInt(String(costFixture["perOrderExecutionGas"])),
    l1DataBytesPerOrder: BigInt(String(costFixture["l1DataBytesPerOrder"])),
    gasPriceWei: BigInt(String(costFixture["gasPriceWei"])),
    investorChargeEurMicros: BigInt(body.investorChargeEurMicros),
    dailyBudgetEurMicros: body.dailyBudgetEurMicros === null ? null : BigInt(body.dailyBudgetEurMicros),
  };
  const result = evaluateCostExperiment(inputs);
  return {
    inputs: {
      dailyOrders: body.dailyOrders,
      eligibleSponsorShareBps: body.eligibleSponsorShareBps,
      daPriceWeiPerByte: body.daPriceWeiPerByte,
      batchUtilizationBps: body.batchUtilizationBps,
      investorChargeEurMicros: body.investorChargeEurMicros,
      dailyBudgetEurMicros: body.dailyBudgetEurMicros,
      rateAgeSeconds: body.rateAgeSeconds,
      rateEurPerEth: RATE.rateEurPerEth,
      executionGasPriceWei: String(costFixture["gasPriceWei"]),
      perOrderExecutionGas: String(costFixture["perOrderExecutionGas"]),
      l1DataBytesPerOrder: String(costFixture["l1DataBytesPerOrder"]),
    },
    result: {
      perOrderSponsorCostWei: result.perOrderSponsorCostWei === null ? null : result.perOrderSponsorCostWei.toString(),
      perOrderSponsorCostEurMicros: result.perOrderSponsorCostEurMicros === null ? null : result.perOrderSponsorCostEurMicros.toString(),
      sponsorContributionPerOrderEurMicros:
        result.sponsorContributionPerOrderEurMicros === null ? null : result.sponsorContributionPerOrderEurMicros.toString(),
      eligibleOrdersPerDay: result.eligibleOrdersPerDay,
      dailySponsorshipNeedEurMicros:
        result.dailySponsorshipNeedEurMicros === null ? null : result.dailySponsorshipNeedEurMicros.toString(),
      dailyBudgetEurMicros: result.dailyBudgetEurMicros === null ? null : result.dailyBudgetEurMicros.toString(),
      budgetRemainingEurMicros: result.budgetRemainingEurMicros === null ? null : result.budgetRemainingEurMicros.toString(),
      budgetExhausted: result.budgetExhausted,
      firstExhaustingDailyOrders: result.firstExhaustingDailyOrders,
      firstSustainableChargeEurMicros:
        result.firstSustainableChargeEurMicros === null ? null : result.firstSustainableChargeEurMicros.toString(),
      unavailable: result.unavailable,
      notes: result.notes,
    },
    dataMode: "scenario",
  };
}

export function readOperationsDashboard(): Record<string, unknown> {
  return readJson<Record<string, unknown>>("benchmarks/operations-dashboard.json");
}
