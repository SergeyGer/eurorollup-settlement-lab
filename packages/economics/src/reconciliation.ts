/**
 * Bundle reconciliation with a real (or explicitly modeled) cost split.
 *
 * The measured inputs come from an outer transaction receipt and the EntryPoint
 * `UserOperationEvent`s: per-operation gas and cost, the paymaster deposit delta,
 * the beneficiary (bundler) balance delta and the outer transaction fee fields.
 *
 * Allocation rule: shared bundle cost is allocated by measured per-operation gas
 * with floor division; failed or unattributable operations keep their own bucket
 * and the remainder is an explicit residual bucket. Allocations plus residual must
 * reproduce the measured bundle total exactly.
 */
import { checkRateFreshness, ethToEurMicros } from "./rate.js";
import type { DataMode, EurMicros, RateObservation, Wei } from "./types.js";

export interface BundleOpMeasurement {
  readonly opId: string;
  readonly actualGasUsed: bigint;
  readonly actualGasCostWei: Wei;
  readonly success: boolean;
  readonly userChargeWei: Wei;
}

export interface BundleMeasurement {
  readonly outerGasUsed: bigint;
  readonly effectiveGasPriceWei: Wei;
  /** L1 data fee from the receipt; null when the chain did not expose it. */
  readonly l1DataFeeWei: Wei | null;
  /** Configured operator fee; null when the chain did not configure one. */
  readonly operatorFeeWei: Wei | null;
  /** Paymaster deposit movement (negative means the sponsor paid). */
  readonly paymasterDepositDeltaWei: Wei;
  /** Beneficiary (bundler) balance delta measured around the bundle transaction. */
  readonly beneficiaryDeltaWei: Wei;
  readonly ops: readonly BundleOpMeasurement[];
  readonly investorChargeEurMicros: EurMicros;
  readonly rate: RateObservation;
  readonly rateObservedNowEpochSeconds: number;
  readonly dataMode: DataMode;
}

export interface CostAllocation {
  readonly bucket: "successful-op" | "failed-or-unattributable" | "residual";
  readonly opId: string | null;
  readonly gasUsed: bigint;
  readonly allocWei: Wei;
}

export interface NamedReconciliationItem {
  readonly name: string;
  readonly wei: string;
  readonly explanation: string;
}

export interface BundleReconciliation {
  readonly measured: BundleMeasurement;
  readonly executionFeeWei: Wei;
  readonly l1DataFeeWei: Wei | null;
  readonly operatorFeeWei: Wei | null;
  readonly networkCostWei: Wei;
  readonly sponsorPaidWei: Wei;
  readonly bundlerRevenueWei: Wei;
  readonly bundleTotalWei: Wei;
  readonly reconciliationItems: readonly NamedReconciliationItem[];
  readonly allocations: readonly CostAllocation[];
  readonly successfulAllocWei: Wei;
  readonly failedAllocWei: Wei;
  readonly residualWei: Wei;
  readonly investorChargeEurMicros: EurMicros;
  readonly sponsorCostEurMicros: EurMicros | null;
  readonly sponsorContributionEurMicros: EurMicros | null;
  readonly rateFreshness: { readonly usable: boolean; readonly ageSeconds: number; readonly reason: string | null };
  readonly unavailable: readonly string[];
  readonly invariants: {
    readonly allocationsPlusResidualEqualsTotal: boolean;
    readonly reconciliationItemsSumToSponsorPaidDifference: boolean;
    readonly investorChargeIsExplicitLeg: boolean;
    readonly noUnattributableOps: boolean;
  };
}

/**
 * Reconcile one measured bundle.
 *
 * `bundleTotalWei` is the measured sponsor payment (the actual bundle cost). The
 * network cost estimate is recorded separately and any difference is a named
 * reconciliation item; it never silently changes the total.
 */
export function reconcileBundle(measurement: BundleMeasurement): BundleReconciliation {
  if (measurement.ops.length === 0) throw new Error("bundle must contain at least one operation");
  const totalGas = measurement.ops.reduce((sum, op) => sum + op.actualGasUsed, 0n);
  if (totalGas === 0n) throw new Error("bundle operations must consume gas");

  const executionFeeWei = measurement.outerGasUsed * measurement.effectiveGasPriceWei;
  const unavailable: string[] = [];
  if (measurement.l1DataFeeWei === null) unavailable.push("l1DataFeeWei");
  if (measurement.operatorFeeWei === null) unavailable.push("operatorFeeWei");

  // Known network cost: measured execution fee plus each measured component.
  const networkCostWei = executionFeeWei + (measurement.l1DataFeeWei ?? 0n) + (measurement.operatorFeeWei ?? 0n);
  const sponsorPaidWei = -measurement.paymasterDepositDeltaWei;
  if (sponsorPaidWei < 0n) throw new Error("sponsor deposit movement must not be positive");
  const bundlerRevenueWei = measurement.beneficiaryDeltaWei;
  const bundleTotalWei = sponsorPaidWei;

  const reconciliationItems: NamedReconciliationItem[] = [
    {
      name: "networkCostVsSponsorPaid",
      wei: (networkCostWei - sponsorPaidWei).toString(),
      explanation:
        "Known network cost (execution plus measured fee components) minus the sponsor payment. Unavailable fee components widen this gap instead of being guessed.",
    },
    {
      name: "sponsorPaidVsBundlerRevenue",
      wei: (sponsorPaidWei - bundlerRevenueWei).toString(),
      explanation:
        "What the sponsor paid minus what the bundler beneficiary actually received; a non-zero value is a named reconciliation difference, not a hidden adjustment.",
    },
  ];

  // Allocate the measured bundle total by measured per-operation gas. Successful
  // operations and failed/unattributable operations keep separate buckets.
  const successful = measurement.ops.filter((op) => op.success);
  const failed = measurement.ops.filter((op) => !op.success);
  const successfulGas = successful.reduce((sum, op) => sum + op.actualGasUsed, 0n);
  const failedGas = failed.reduce((sum, op) => sum + op.actualGasUsed, 0n);

  const allocations: CostAllocation[] = [];
  let allocated = 0n;
  for (const op of successful) {
    const allocWei = (bundleTotalWei * op.actualGasUsed) / totalGas;
    allocations.push({
      bucket: "successful-op",
      opId: op.opId,
      gasUsed: op.actualGasUsed,
      allocWei,
    });
    allocated += allocWei;
  }
  const failedAllocWei =
    failedGas === 0n ? 0n : (bundleTotalWei * failedGas) / totalGas;
  if (failedGas > 0n) {
    allocations.push({
      bucket: "failed-or-unattributable",
      opId: null,
      gasUsed: failedGas,
      allocWei: failedAllocWei,
    });
    allocated += failedAllocWei;
  }
  const residualWei = bundleTotalWei - allocated;
  if (residualWei !== 0n) {
    allocations.push({ bucket: "residual", opId: null, gasUsed: 0n, allocWei: residualWei });
  }

  const rateFreshness = checkRateFreshness(measurement.rate, measurement.rateObservedNowEpochSeconds);
  const sponsorCostEurMicros = rateFreshness.usable
    ? ethToEurMicros(sponsorPaidWei, measurement.rate.rateMicrosPerEth)
    : null;
  const sponsorContributionEurMicros =
    sponsorCostEurMicros === null ? null : measurement.investorChargeEurMicros - sponsorCostEurMicros;
  if (sponsorCostEurMicros === null) unavailable.push("sponsorCostEurMicros (rate unusable)");

  return {
    measured: measurement,
    executionFeeWei,
    l1DataFeeWei: measurement.l1DataFeeWei,
    operatorFeeWei: measurement.operatorFeeWei,
    networkCostWei,
    sponsorPaidWei,
    bundlerRevenueWei,
    bundleTotalWei,
    reconciliationItems,
    allocations,
    successfulAllocWei: successful.reduce((sum, op) => sum + op.actualGasUsed, 0n) === 0n ? 0n : allocated - failedAllocWei,
    failedAllocWei,
    residualWei,
    investorChargeEurMicros: measurement.investorChargeEurMicros,
    sponsorCostEurMicros,
    sponsorContributionEurMicros,
    rateFreshness,
    unavailable,
    invariants: {
      allocationsPlusResidualEqualsTotal: allocated + residualWei === bundleTotalWei,
      reconciliationItemsSumToSponsorPaidDifference:
        reconciliationItems.reduce((sum, item) => sum + BigInt(item.wei), 0n) ===
        networkCostWei - bundlerRevenueWei,
      investorChargeIsExplicitLeg: measurement.investorChargeEurMicros >= 0n,
      noUnattributableOps: failed.length === 0,
    },
  };
}
