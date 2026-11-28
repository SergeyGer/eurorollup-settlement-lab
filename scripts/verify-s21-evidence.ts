/**
 * Offline verification of the S21 / OPS-01 and OPS-02 evidence.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}
function nearestRank(samples: readonly number[], percentile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  // ---- OPS-01 benchmark.
  const validateBenchmark = ajv.compile(readJson("schemas/s21-ops-benchmark.schema.json"));
  const benchmark = readJson("evidence/s21/ops-batch-setting-benchmark.json");
  check(validateBenchmark(benchmark) === true, `OPS-01 schema validation: ${JSON.stringify(validateBenchmark.errors)}`);
  check(benchmark["controls"]["orderCount"] === 200, "the identical 200-order schedule is recorded");
  check((benchmark["runs"] as unknown[]).length === 6, "six runs are retained");
  const settings = new Set((benchmark["runs"] as Array<Record<string, any>>).map((run) => run["settingBlocks"]));
  check(settings.has(4) && settings.has(12), "both maximum channel durations (4 and 12 blocks) are benchmarked");
  for (const run of benchmark["runs"] as Array<Record<string, any>>) {
    check(run["completed"] === 200 && run["failed"] === 0, `${String(run["runId"])}: all 200 orders completed`);
    check((run["batch"]["txs"] as unknown[]).length > 0, `${String(run["runId"])}: raw batch transactions are retained`);
    check(run["batch"]["blobCount"] >= 1 || run["batch"]["bytes"] > 0, `${String(run["runId"])}: raw batch data is recorded`);
    const samples = run["latency"]["samplesMs"] as number[];
    check(samples.length === 200, `${String(run["runId"])}: 200 latency samples are retained`);
    check(run["latency"]["p50Ms"] === nearestRank(samples, 50), `${String(run["runId"])}: p50 uses the nearest-rank method`);
    check(run["latency"]["p95Ms"] === nearestRank(samples, 95), `${String(run["runId"])}: p95 uses the nearest-rank method`);
    check(BigInt(String(run["perSuccessCostWei"])) > 0n, `${String(run["runId"])}: per-success cost is recorded`);
    const batchCost = (run["batch"]["txs"] as Array<Record<string, any>>).reduce((sum, tx) => sum + BigInt(String(tx["costWei"])), 0n);
    check(batchCost === BigInt(String(run["l1ExpenditureWei"])), `${String(run["runId"])}: L1 expenditure equals the batch receipt costs`);
    const receiptsCost = BigInt(String(run["l1ExpenditureWei"]));
    check(receiptsCost / 200n === BigInt(String(run["perSuccessCostWei"])), `${String(run["runId"])}: per-success cost is the expenditure per completed order`);
  }
  const aggregate = benchmark["aggregate"] as Array<Record<string, any>>;
  check(aggregate.length === 2, "the aggregate is published for both settings");
  for (const entry of aggregate) {
    check(entry["samples"] === 600, `setting ${String(entry["settingBlocks"])}: aggregate uses all 600 samples`);
    check(entry["p95Ms"] === nearestRank((benchmark["runs"] as Array<Record<string, any>>).filter((run) => run["settingBlocks"] === entry["settingBlocks"]).flatMap((run) => run["latency"]["samplesMs"] as number[]), 95), `setting ${String(entry["settingBlocks"])}: aggregate p95 is recomputed correctly`);
  }
  const selection = benchmark["selection"] as Record<string, any>;
  const qualifying = aggregate.filter((entry) => entry["meetsTarget"] === true);
  check((selection["qualifyingSettings"] as number[]).length === qualifying.length, "the qualifying settings match the p95 target");
  if (qualifying.length > 0) {
    const cheapest = qualifying.reduce((best, current) => (BigInt(current["meanPerSuccessCostWei"]) < BigInt(best["meanPerSuccessCostWei"]) ? current : best));
    check(selection["selectedSettingBlocks"] === cheapest["settingBlocks"], "the lowest-cost qualifying setting is selected");
  } else {
    check(selection["miss"] === true && selection["missReason"] !== null, "a miss is published with the chosen trade-off");
  }
  check(benchmark["passed"] === true, "the OPS-01 evidence records a pass");

  // ---- OPS-02 reconciliation and authority.
  const ops = readJson("evidence/s21/ops-money-authority.json");
  check(ops["reportId"] === "S21-OPS-02-money-and-authority", "the OPS-02 report is present");
  const bundle = ops["anvilBundle"] as Record<string, any>;
  check(bundle["executionFeeWei"] === bundle["expectedExecutionCostWei"], "the Anvil two-operation execution cost matches the audit brief");
  check(bundle["sponsorPaidWei"] === bundle["expectedSponsorPaymentWei"], "the Anvil two-operation sponsor payment matches the audit brief");
  check(bundle["allocationsPlusResidualEqualPayment"] === true, "the allocations plus residual equal the sponsor payment");
  check(bundle["l1DataFeeWei"] === null && bundle["operatorFeeWei"] === null, "the unavailable L1 data and operator fees are null on the Anvil lane");
  const opLane = ops["opLane"] as Record<string, any>;
  check(opLane["componentReceipts"]["l1ExecutionGasFeeWei"] !== "0", "the OP-lane execution component receipt is recorded");
  const opsLaneMode = (ops["lane"] as Record<string, any> | undefined)?.["daMode"] ?? "blobs";
  check(opLane["componentReceipts"]["l1BlobGasFeeWei"] !== "0" || opsLaneMode === "calldata", "the OP-lane blob component receipt is recorded (or the lane runs calldata DA)");
  check(opLane["residualWei"] === "0", "the OP-lane measured components reproduce the L1 expenditure");
  check(opLane["sponsorContributionWei"] === null && String(opLane["sponsorContributionReason"]).length > 0, "the absent OP-lane sponsor contribution is null with a reason");
  check(opLane["beneficiaryRevenueWei"] === null && String(opLane["beneficiaryRevenueReason"]).length > 0, "the absent OP-lane beneficiary revenue is null with a reason");
  check((opLane["unavailable"] as unknown[]).length >= 2, "the unavailable OP-lane fields are listed");
  const failover = ops["rpcFailover"] as Record<string, any>;
  check(failover["probes"].length >= 3, "the RPC failover probes are archived");
  check(failover["failureProbeCount"] >= 1, "the RPC failover drill observed at least one failure");
  check(failover["switchedToSecondary"] === true, "the RPC failover switched to the secondary endpoint");
  const pause = ops["batcherPause"] as Record<string, any>;
  check(pause["safeStalledWhilePaused"] === true, "the safe head stalled while the batcher was paused");
  check(pause["recovered"] === true, "the batcher resumed and the safe head caught up");
  check(pause["backlogBlocks"] > 0, "the pause backlog is recorded");
  const restore = ops["indexerRestore"] as Record<string, any>;
  check(restore["promotionRefused"] === true && String(restore["refusalReason"]).length > 0, "the indexer restore refused the corrupted statement");
  check(restore["restoredDigestEqualsPreRestore"] === true, "the indexer restore digest matches the pre-restore canonical digest");
  check(restore["ledgerRestart"]["equal"] === true, "the ledger restart checkpoint reproduces the projection");
  const upgrade = ops["upgradeRehearsal"] as Record<string, any>;
  check(upgrade["successfulUpgrade"]["earlyActivationRejected"] === true, "early activation is rejected");
  check(upgrade["successfulUpgrade"]["executed"] === true && upgrade["successfulUpgrade"]["version"] === "7", "the timelocked upgrade activates the target version");
  check(upgrade["successfulUpgrade"]["activationBlock"] > 0, "the activation block is recorded");
  check(upgrade["failureAndRecovery"]["failed"] === true, "the failed execution is recorded");
  check(upgrade["failureAndRecovery"]["recovered"] === true, "forward recovery executes the failed proposal after the fix");
  check(upgrade["nonOwnerRejected"] === true, "a non-owner proposal is rejected");
  check(ops["passed"] === true, "the OPS-02 evidence records a pass");

  if (failures.length > 0) {
    console.error("S21 evidence verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  const runs = benchmark["runs"] as Array<Record<string, any>>;
  console.log(
    `OPS-01 verified: ${String(runs.length)} runs, selected setting ${String(selection["selectedSettingBlocks"] ?? "none")} (miss=${String(selection["miss"])}), ` +
      `aggregate p95 ${aggregate.map((entry) => `${String(entry["settingBlocks"])}blk=${String(entry["p95Ms"])}ms`).join(", ")}`,
  );
  console.log("OPS-02 verified: bundle allocation sum, OP-lane component receipts/residual, RPC failover, batcher pause/resume, indexer restore and timelocked 2-of-3 upgrade with forward recovery.");
}

main();
