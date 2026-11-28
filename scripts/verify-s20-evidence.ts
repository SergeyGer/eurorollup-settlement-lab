/**
 * Offline verification of the S20 / LED-01 reconciliation and reorg-recovery evidence.
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

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/s20-reconciliation-reorg.schema.json"));
  const evidence = readJson("evidence/s20/reconciliation-reorg.json");
  check(validate(evidence) === true, `schema validation: ${JSON.stringify(validate.errors)}`);
  check(evidence["chain"]["chainId"] === 16584, "the drill runs on the expected chain id");
  check(evidence["chain"]["exactBlockHashMethod"] === "EIP-1898 eth_call blockHash parameter", "exact-block-hash reads use EIP-1898");
  check(evidence["chain"]["reorgRpc"] === "anvil_reorg", "the controlled reorg uses anvil_reorg");

  const branches = evidence["branches"] as Record<string, any>;
  check((branches["previous"]["blocks"] as unknown[]).length >= 2, "the previous branch has at least two blocks");
  check((branches["previous"]["orphanedBlockHashes"] as string[]).every((hash) => HEX32.test(hash)), "the orphaned block hashes are recorded");
  check((branches["replacement"]["blocks"] as unknown[]).length >= 4, "the replacement branch has the empty replacements and the replacement activity");
  check(typeof branches["commonAncestor"]["blockHash"] === "string" && HEX32.test(branches["commonAncestor"]["blockHash"]), "the common ancestor is recorded");

  const reorg = evidence["reorg"] as Record<string, any>;
  check(reorg["orphanedEvents"].length >= 3, "the orphaned events are recorded");
  check(reorg["replayedEvents"].length >= 3, "the replacement events are replayed");
  check(reorg["duplicatesSkipped"] >= 1, "duplicate delivery is counted");
  check(HEX32.test(String(reorg["commonAncestorBlockHash"])), "the reorg result names the common ancestor");
  const releaseCounts = Object.values(reorg["releasedReservations"] as Record<string, number>);
  check(releaseCounts.length >= 1 && releaseCounts.every((count) => count === 1), "every reservation is released exactly once");

  const anchors = evidence["anchors"] as Record<string, any>;
  check(HEX32.test(String(anchors["accepted"]["blockHash"])), "the accepted anchor is an exact block hash");
  check(HEX32.test(String(anchors["rejected"]["orphanBlockHash"])), "the rejected orphan anchor is recorded");
  check(String(anchors["rejected"]["canonicalReason"]).includes("NONCANONICAL_ANCHOR"), "the noncanonical anchor is rejected with the canonical reason");
  check(anchors["rejected"]["exactHashBalanceRejected"] === true, "the exact-hash balance read on the orphan block fails");
  check(String(anchors["rejected"]["exactHashBalanceError"]).length > 0, "the exact-hash rejection error is recorded");

  const duplicate = evidence["duplicate"] as Record<string, any>;
  check(duplicate["duplicatesSkipped"] >= 1 && duplicate["idempotent"] === true, "duplicate blocks are idempotent");
  const restart = evidence["restart"] as Record<string, any>;
  check(restart["equal"] === true, "the interrupted-restart projection equals the uninterrupted projection");
  check(String(restart["projectionSha256"]) === String(restart["restoredProjectionSha256"]), "the restored projection digest matches");
  check(/^[0-9a-f]{64}$/.test(String(restart["checkpointSha256"])), "the checkpoint digest is recorded");

  const reconciliation = evidence["reconciliation"] as Record<string, any>;
  check((reconciliation["balanceResult"]["differences"] as unknown[]).length === 0, "there are zero per-account balance differences");
  for (const [assetId, entry] of Object.entries(reconciliation["balanceResult"]["perAsset"] as Record<string, any>)) {
    check(entry["difference"] === "0", `the ${assetId} projected/observed totals match`);
  }
  for (const [assetId, entry] of Object.entries(reconciliation["conservation"] as Record<string, any>)) {
    check(entry["conserved"] === true, `the ${assetId} asset is conserved`);
    check(String(entry["observedAccountsTotal"]) === String(entry["totalSupply"]), `the ${assetId} account total equals the total supply`);
  }

  const auditTrail = evidence["auditTrail"] as Array<Record<string, any>>;
  check(auditTrail.some((entry) => entry["action"] === "orphan"), "the audit trail keeps the orphaned branch");
  check(auditTrail.some((entry) => entry["action"] === "replay"), "the audit trail keeps the replacement branch");
  check(auditTrail.some((entry) => entry["action"] === "apply"), "the audit trail keeps applied events");
  check(evidence["passed"] === true, "the S20 evidence records a pass");
  check((evidence["limitations"] as unknown[]).length >= 3, "limitations are recorded");

  if (failures.length > 0) {
    console.error("S20 reconciliation evidence verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `LED-01 verified: ${String(reorg["orphanedEvents"].length)} orphaned events, ${String(reorg["replayedEvents"].length)} replayed, ` +
      `${String(reorg["duplicatesSkipped"])} duplicates skipped, noncanonical anchor rejected, restart equal, ` +
      `${String(auditTrail.length)} audit entries, zero per-account differences at exact block hash`,
  );
}

main();
