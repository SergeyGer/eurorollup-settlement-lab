/**
 * Frozen A07 economics inputs for the browser cost experiment.
 *
 * The observed bundle, the scenario defaults and the demo rate are committed
 * evidence/fixture files. The browser recomputes scenarios locally with the same
 * deterministic package the API and CLI use.
 */
import observedBundleJson from "../../../../evidence/a07/bundle-reconciliation.json";
import costExperimentJson from "../../../../benchmarks/cost-experiment.json";
import rateJson from "../../../../fixtures/economics/rate.json";
import costInputsJson from "../../../../fixtures/economics/cost-inputs.json";

export const observedBundle = observedBundleJson as unknown as {
  bundle: {
    outerTxHash: string;
    outerStatus: number;
    outerGasUsed: string;
    effectiveGasPriceWei: string;
    sponsorPaidWei: string;
    bundlerRevenueWei: string;
    bundleTotalWei: string;
    networkCostWei: string;
    operations: Array<{ opId: string; success: boolean; actualGasUsed: string; actualGasCostWei: string }>;
  };
  reconciliation: {
    allocations: Array<{ bucket: string; opId: string | null; gasUsed: string; allocWei: string }>;
    residualWei: string;
    failedAllocWei: string;
    invariants: Record<string, boolean>;
  };
  charges: {
    investorChargeEurMicros: string;
    sponsorCostEurMicros: string | null;
    sponsorContributionEurMicros: string | null;
    rateObservation: { rateEurPerEth: string; observedAt: string; source: string };
  };
  unavailable: string[];
  dataMode: string;
};

export const costExperiment = costExperimentJson as unknown as {
  observedDefaults: { perOrderExecutionGas: string; gasPriceWei: string; dataMode: string };
  scenarioInputs: {
    dailyOrders: number;
    eligibleSponsorShareBps: number;
    daPriceWeiPerByte: number;
    batchUtilizationBps: number;
    l1DataBytesPerOrder: number;
    investorChargeEurMicros: number;
    dailyBudgetEurMicros: number;
  };
  scenarios: Array<{ scenarioId: string; description: string }>;
};

export const rateFixture = rateJson as unknown as { rateEurPerEth: string; rateMicrosPerEth: string; observedAt: string; maxAgeSeconds: number };
export const costInputsFixture = costInputsJson as unknown as typeof costInputsJson;

export function formatEth(wei: string): string {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${whole.toString()}.${fraction}`;
}

export function formatEurMicros(micros: string | null): string {
  if (micros === null) return "unavailable";
  const value = BigInt(micros);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "−" : ""}${(absolute / 1_000_000n).toString()}.${(absolute % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
}
