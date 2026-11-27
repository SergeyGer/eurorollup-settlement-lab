/**
 * Offline verification of the committed A07 economics evidence.
 *
 * CI cannot start the local chain, so this verifier checks that the measured
 * bundle is internally consistent: the outer transaction succeeded, the sponsor
 * payment is positive, per-operation allocations plus the residual reproduce the
 * bundle total, unavailable fee components are recorded as null, the explicit
 * investor charge and the demo rate are present, and the cost experiment records a
 * default scenario plus an exhaustion point. Schema validation uses the committed
 * versioned schemas.
 *
 * Live re-capture: `pnpm a07:economics`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

interface BundleEvidence {
  bundle: {
    outerTxHash: string;
    outerStatus: number;
    sponsorPaidWei: string;
    bundlerRevenueWei: string;
    bundleTotalWei: string;
    networkCostWei: string;
    l1DataFeeWei: string | null;
    operatorFeeWei: string | null;
    operations: Array<{ opId: string; success: boolean; actualGasUsed: string; actualGasCostWei: string; userChargeWei: string }>;
  };
  reconciliation: {
    items: Array<{ name: string; wei: string }>;
    allocations: Array<{ bucket: string; allocWei: string }>;
    successfulAllocWei: string;
    failedAllocWei: string;
    residualWei: string;
    invariants: {
      allocationsPlusResidualEqualsTotal: boolean;
      reconciliationItemsSumToSponsorPaidDifference: boolean;
      investorChargeIsExplicitLeg: boolean;
    };
  };
  charges: {
    investorChargeEurMicros: string;
    sponsorCostEurMicros: string | null;
    sponsorContributionEurMicros: string | null;
    rateFreshness: { usable: boolean };
  };
  unavailable: string[];
  dataMode: string;
}

interface ExperimentEvidence {
  observedRun: { bundleOuterTxHash: string; sponsorPaidWei: string };
  scenarios: Array<{
    scenarioId: string;
    inputs: Record<string, unknown>;
    result: {
      perOrderSponsorCostWei: string | null;
      sponsorContributionPerOrderEurMicros: string | null;
      firstExhaustingDailyOrders: number | null;
      firstSustainableChargeEurMicros: string | null;
      unavailable: string[];
    };
  }>;
  unavailable: string[];
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const bundleSchema = ajv.compile(readJson("schemas/a07-bundle-reconciliation.schema.json") as object);
  const experimentSchema = ajv.compile(readJson("schemas/a07-cost-experiment.schema.json") as object);
  const bundle = readJson("evidence/a07/bundle-reconciliation.json") as BundleEvidence;
  const experiment = readJson("benchmarks/cost-experiment.json") as ExperimentEvidence;

  check(bundleSchema(bundle), `bundle schema: ${JSON.stringify(bundleSchema.errors)}`);
  check(experimentSchema(experiment), `cost-experiment schema: ${JSON.stringify(experimentSchema.errors)}`);

  // --- measured bundle ---
  check(/^0x[0-9a-fA-F]{64}$/.test(bundle.bundle.outerTxHash), "outer transaction hash");
  check(bundle.bundle.outerStatus === 1, "the bundle outer transaction must succeed");
  const sponsorPaid = BigInt(bundle.bundle.sponsorPaidWei);
  check(sponsorPaid > 0n, "the sponsor payment must be positive");
  check(BigInt(bundle.bundle.bundleTotalWei) === sponsorPaid, "bundle total must equal the measured sponsor payment");
  check(BigInt(bundle.bundle.bundlerRevenueWei) > 0n, "the bundler beneficiary must receive the bundle fee");
  check(BigInt(bundle.bundle.sponsorPaidWei) === BigInt(bundle.bundle.bundlerRevenueWei), "measured sponsor payment must equal the bundler revenue");
  check(BigInt(bundle.bundle.networkCostWei) > 0n, "network cost must be positive");
  check(bundle.bundle.l1DataFeeWei === null && bundle.bundle.operatorFeeWei === null, "unavailable fee components must be recorded as null");
  check(bundle.unavailable.includes("l1DataFeeWei") && bundle.unavailable.includes("operatorFeeWei"), "unavailable list must name both missing fee components");
  check(bundle.dataMode.includes("measured"), "data mode must state that the bundle is measured");

  check(bundle.bundle.operations.length >= 2, "the bundle must contain at least two operations");
  check(bundle.bundle.operations.some((op) => op.success), "the bundle must contain a successful operation");
  check(bundle.bundle.operations.some((op) => !op.success && op.opId.includes("failure")), "the bundle must contain an included failure");
  check(
    bundle.bundle.operations.reduce((sum, op) => sum + BigInt(op.actualGasCostWei), 0n) === sponsorPaid,
    "per-operation actual costs must reproduce the sponsor payment",
  );

  const allocations = bundle.reconciliation.allocations.reduce((sum, entry) => sum + BigInt(entry.allocWei), 0n);
  check(allocations + BigInt(bundle.reconciliation.residualWei) === BigInt(bundle.bundle.bundleTotalWei), "allocations plus residual must reproduce the bundle total");
  check(bundle.reconciliation.invariants.allocationsPlusResidualEqualsTotal, "allocation invariant flag");
  check(bundle.reconciliation.invariants.investorChargeIsExplicitLeg, "investor charge must be an explicit leg");
  check(BigInt(bundle.reconciliation.failedAllocWei) > 0n, "the failed/unattributable bucket must be non-empty");
  check(
    bundle.reconciliation.allocations.some((entry) => entry.bucket === "failed-or-unattributable"),
    "a separate failed/unattributable bucket must exist",
  );
  check(BigInt(bundle.reconciliation.successfulAllocWei) + BigInt(bundle.reconciliation.failedAllocWei) + BigInt(bundle.reconciliation.residualWei) === BigInt(bundle.bundle.bundleTotalWei), "successful + failed + residual must reproduce the total");
  check(bundle.reconciliation.invariants.reconciliationItemsSumToSponsorPaidDifference, "named reconciliation items must sum consistently");

  check(BigInt(bundle.charges.investorChargeEurMicros) === 50_000n, "the explicit investor charge must be 0.05 EUR (50 000 micro-EUR)");
  check(bundle.charges.rateFreshness.usable, "the demo rate must be fresh at the recorded measurement time");
  if (bundle.charges.sponsorCostEurMicros !== null && bundle.charges.sponsorContributionEurMicros !== null) {
    check(
      BigInt(bundle.charges.sponsorContributionEurMicros) ===
        BigInt(bundle.charges.investorChargeEurMicros) - BigInt(bundle.charges.sponsorCostEurMicros),
      "sponsor contribution must equal the investor charge minus the sponsor cost",
    );
  }

  // --- cost experiment ---
  check(experiment.observedRun.bundleOuterTxHash === bundle.bundle.outerTxHash, "the experiment's observed run must reference the measured bundle");
  check(experiment.scenarios.length >= 3, "at least three scenarios are required");
  check(experiment.scenarios.some((scenario) => scenario.scenarioId === "observed-default"), "a default scenario is required");
  const defaultScenario = experiment.scenarios.find((scenario) => scenario.scenarioId === "observed-default")!;
  check(defaultScenario.result.perOrderSponsorCostWei !== null, "the default scenario must compute the sponsor cost");
  check(
    experiment.scenarios.some((scenario) => scenario.result.firstExhaustingDailyOrders !== null),
    "at least one scenario must reach a budget exhaustion point",
  );
  const lowerFee = experiment.scenarios.find((scenario) => scenario.scenarioId === "lower-investor-fee");
  check(lowerFee !== undefined, "the lower-investor-fee scenario is required");
  if (lowerFee !== undefined) {
    check(
      lowerFee.result.firstExhaustingDailyOrders !== null || lowerFee.result.unavailable.length > 0,
      "a lower investor charge must either exhaust the budget or state why it is unavailable",
    );
  }

  if (failures.length > 0) {
    console.error("A07 economics evidence verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `A07 economics verified: bundle ${bundle.bundle.outerTxHash} paid ${bundle.bundle.sponsorPaidWei} wei in total, ` +
      `${bundle.reconciliation.allocations.length.toString()} allocations including a failed bucket; ` +
      `${experiment.scenarios.length.toString()} cost scenarios`,
  );
}

main();
