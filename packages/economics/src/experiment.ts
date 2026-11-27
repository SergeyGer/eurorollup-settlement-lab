/**
 * Interactive cost experiment model.
 *
 * Inputs are explicit and all arithmetic is integer based. Missing inputs are
 * returned as `null` outputs plus an `unavailable` list; the UI must display
 * "unavailable" instead of zero. The default view compares the last recorded
 * observation with an editable scenario.
 */
import { ethToEurMicros } from "./rate.js";
import type { EurMicros, RateObservation, Wei } from "./types.js";

export interface CostExperimentInputs {
  /** Orders per day in the scenario. */
  readonly dailyOrders: number;
  /** Share of orders that are eligible for sponsorship, in basis points (0..10000). */
  readonly eligibleSponsorShareBps: number;
  readonly rate: RateObservation;
  /** Observed or configured EUR/ETH rate age at evaluation time, in seconds. */
  readonly rateAgeSeconds: number;
  /** Configured DA price in wei per published data byte; null = not available. */
  readonly daPriceWeiPerByte: Wei | null;
  /** Batch utilization in basis points (0..10000); 0 makes DA cost unavailable. */
  readonly batchUtilizationBps: number;
  /** Measured or assumed execution gas per order. */
  readonly perOrderExecutionGas: bigint;
  /** Published L1 data bytes per order. */
  readonly l1DataBytesPerOrder: bigint;
  /** Gas price used to convert execution gas into wei. */
  readonly gasPriceWei: Wei;
  /** Explicit investor charge per successful spot order (0.05 dEUR = 50_000 micro-EUR). */
  readonly investorChargeEurMicros: EurMicros;
  /** Optional measured override for the sponsor cost per order, in wei. */
  readonly measuredSponsorCostPerOrderWei?: Wei;
  /** Daily sponsorship budget in micro-EUR; null = not configured. */
  readonly dailyBudgetEurMicros: EurMicros | null;
}

export interface CostExperimentResult {
  readonly perOrderSponsorCostWei: Wei | null;
  readonly perOrderSponsorCostEurMicros: EurMicros | null;
  readonly sponsorContributionPerOrderEurMicros: EurMicros | null;
  readonly eligibleOrdersPerDay: number;
  readonly dailySponsorshipNeedEurMicros: EurMicros | null;
  readonly dailyBudgetEurMicros: EurMicros | null;
  readonly budgetRemainingEurMicros: EurMicros | null;
  readonly budgetExhausted: boolean;
  /** First daily order count at which the budget is exhausted, or null if it is never reached. */
  readonly firstExhaustingDailyOrders: number | null;
  /** First investor charge (micro-EUR) that keeps the budget unexhausted, or null if none exists. */
  readonly firstSustainableChargeEurMicros: EurMicros | null;
  readonly unavailable: readonly string[];
  readonly notes: readonly string[];
}

function daCostPerOrderWei(inputs: CostExperimentInputs): Wei | null {
  if (inputs.daPriceWeiPerByte === null) return null;
  if (inputs.batchUtilizationBps <= 0) return null;
  const publishedCost = inputs.l1DataBytesPerOrder * inputs.daPriceWeiPerByte;
  // Effective DA cost rises as utilization falls: cost / utilization.
  return (publishedCost * 10_000n) / BigInt(inputs.batchUtilizationBps);
}

export function sponsorCostPerOrderWei(inputs: CostExperimentInputs): Wei | null {
  if (inputs.measuredSponsorCostPerOrderWei !== undefined) return inputs.measuredSponsorCostPerOrderWei;
  const execution = inputs.perOrderExecutionGas * inputs.gasPriceWei;
  const da = daCostPerOrderWei(inputs);
  if (da === null) return null;
  return execution + da;
}

export function evaluateCostExperiment(inputs: CostExperimentInputs): CostExperimentResult {
  const unavailable: string[] = [];
  const notes: string[] = [];
  if (inputs.rateAgeSeconds > inputs.rate.maxAgeSeconds) {
    unavailable.push("rate");
    notes.push("rate observation is stale, so euro conversions are unavailable");
  }
  if (inputs.daPriceWeiPerByte === null) {
    unavailable.push("daPriceWeiPerByte");
    notes.push("DA price was not provided, so the sponsor cost per order is unavailable");
  } else if (inputs.batchUtilizationBps <= 0) {
    unavailable.push("batchUtilizationBps");
    notes.push("batch utilization must be positive to price DA cost");
  }
  if (inputs.dailyBudgetEurMicros === null) {
    unavailable.push("dailyBudgetEurMicros");
    notes.push("no daily sponsorship budget was configured");
  }

  const perOrderWei = sponsorCostPerOrderWei(inputs);
  const perOrderEur = perOrderWei === null ? null : ethToEurMicros(perOrderWei, inputs.rate.rateMicrosPerEth);
  const contribution = perOrderEur === null ? null : inputs.investorChargeEurMicros - perOrderEur;
  const eligibleOrdersPerDay = Math.floor((inputs.dailyOrders * inputs.eligibleSponsorShareBps) / 10_000);

  const dailyNeed =
    perOrderEur === null ? null : (perOrderEur - inputs.investorChargeEurMicros > 0n ? perOrderEur - inputs.investorChargeEurMicros : 0n) * BigInt(eligibleOrdersPerDay);
  const budgetRemaining =
    dailyNeed === null || inputs.dailyBudgetEurMicros === null ? null : inputs.dailyBudgetEurMicros - dailyNeed;
  const budgetExhausted = budgetRemaining !== null && budgetRemaining < 0n;

  // Sweep order volume: first count at which the daily need exceeds the budget.
  let firstExhaustingDailyOrders: number | null = null;
  if (perOrderEur !== null && inputs.dailyBudgetEurMicros !== null) {
    const subsidyPerOrder = perOrderEur - inputs.investorChargeEurMicros;
    if (subsidyPerOrder > 0n) {
      const maxOrders = 10_000;
      const maxEligible = Math.floor((maxOrders * inputs.eligibleSponsorShareBps) / 10_000);
      for (let orders = 1; orders <= maxOrders; orders += 1) {
        const eligible = Math.floor((orders * inputs.eligibleSponsorShareBps) / 10_000);
        if (eligible > 0 && subsidyPerOrder * BigInt(eligible) > inputs.dailyBudgetEurMicros) {
          firstExhaustingDailyOrders = orders;
          break;
        }
      }
      if (firstExhaustingDailyOrders === null && maxEligible > 0) {
        notes.push("the budget is not exhausted within the swept order range");
      }
    } else {
      notes.push("the investor charge covers the sponsor cost, so no subsidy budget is needed");
    }
  }

  // The break-even investor charge is the per-order sponsor cost: at or above it
  // the contribution is non-negative and no subsidy budget is needed.
  const firstSustainableCharge: EurMicros | null = perOrderEur;

  return {
    perOrderSponsorCostWei: perOrderWei,
    perOrderSponsorCostEurMicros: perOrderEur,
    sponsorContributionPerOrderEurMicros: contribution,
    eligibleOrdersPerDay,
    dailySponsorshipNeedEurMicros: dailyNeed,
    dailyBudgetEurMicros: inputs.dailyBudgetEurMicros,
    budgetRemainingEurMicros: budgetRemaining,
    budgetExhausted,
    firstExhaustingDailyOrders,
    firstSustainableChargeEurMicros: firstSustainableCharge,
    unavailable,
    notes,
  };
}

export interface ExperimentScenario {
  readonly scenarioId: string;
  readonly description: string;
  readonly inputs: CostExperimentInputs;
  readonly result: CostExperimentResult;
}

export function runScenarioMatrix(
  base: CostExperimentInputs,
  overrides: ReadonlyArray<{ scenarioId: string; description: string; patch: Partial<CostExperimentInputs> }>,
): readonly ExperimentScenario[] {
  return overrides.map((override) => {
    const inputs = { ...base, ...override.patch };
    return { scenarioId: override.scenarioId, description: override.description, inputs, result: evaluateCostExperiment(inputs) };
  });
}
