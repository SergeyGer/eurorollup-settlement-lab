/**
 * Offline verification of the S18 / SET-04 settlement pack acceptance evidence.
 *
 * Re-runs the pack verifier on the committed pack, requires the deterministic tamper copy
 * to fail with a first mismatch, checks the UI download identity, the joined chain witness,
 * the canonical-block balance comparisons and the null-with-reason contract for unknown
 * chain fields.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { verifySettlementPack } from "./verify-settlement-pack.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

async function main(): Promise<void> {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/s18-settlement-pack-run.schema.json"));
  const evidence = readJson("evidence/s18/settlement-pack-run.json");
  check(validate(evidence) === true, `schema validation: ${JSON.stringify(validate.errors)}`);

  check(evidence["chains"]["l2ChainId"] === 16584, "the private L2 chain id is recorded");
  check(evidence["run"]["runId"] === evidence["run"]["orderId"], "the run id and order id are joined");
  check(evidence["order"]["businessState"] === "FILLED", "the SDK G01 order is filled");
  check(evidence["api"]["endpoint"] === `/v1/runs/${String(evidence["run"]["orderId"])}/evidence`, "the investment-run evidence endpoint is recorded");

  const pack = evidence["pack"] as Record<string, any>;
  const good = await verifySettlementPack(pack);
  check(good.passed === true, `the committed pack must verify offline: ${good.mismatches[0] ?? ""}`);
  check(good.checks >= 15, "the pack verifier ran its full check set");
  const tampered = structuredClone(pack);
  tampered["business"]["receipt"]["cashDeployedBase"] = (BigInt(String(tampered["business"]["receipt"]["cashDeployedBase"])) + 1n).toString();
  const tamperedResult = await verifySettlementPack(tampered);
  check(tamperedResult.passed === false, "the tampered pack must fail verification");
  check(tamperedResult.mismatches.length > 0 && tamperedResult.mismatches[0]!.startsWith("manifest-section-business"), "the tampered pack must fail first on the changed business manifest section");
  check(evidence["verification"]["offline"]["exitCode"] === 0, "the recorded offline verification exited zero");
  check(evidence["verification"]["chainFollow"]["exitCode"] === 0, "the recorded chain-follow verification exited zero");
  check(evidence["verification"]["tampered"]["exitCode"] >= 1 && evidence["verification"]["tampered"]["firstMismatch"] !== null, "the recorded tamper run exited non-zero with a first mismatch");
  check(evidence["verification"]["tampered"]["firstMismatch"].startsWith("MISMATCH:"), "the first mismatch is reported");
  check(sha256(`${JSON.stringify(pack, null, 2)}\n`) === evidence["packSha256"], "the pack digest matches the committed pack bytes");

  const chain = pack["chain"] as Record<string, any>;
  const witness = evidence["chainWitness"] as Record<string, any>;
  check(chain["status"] === "OBSERVED", "the pack carries an observed chain witness");
  check(chain["txHash"] === witness["txHash"] && chain["logIndex"] === witness["logIndex"], "the pack joins the witness transaction and log index");
  check(chain["l2BlockHash"] === witness["l2BlockHash"] && chain["canonicalBlockHash"] === witness["canonicalBlockHash"], "the pack joins the L2 transaction block and canonical observation block hashes");
  check(chain["policyHash"] === witness["policyHash"] && chain["policyHash"] === evidence["pack"]["environment"]["policyHash"], "the pack joins the policy hash");
  check(chain["orderIdBytes32"] === witness["orderIdBytes32"], "the pack joins the onchain order id projection");
  check(witness["receiptStatus"] === 1 && chain["receiptStatus"] === 1, "the witness transaction succeeded");
  check(chain["unknowns"].some((entry: Record<string, any>) => entry["field"] === "chain.userOpHash" && String(entry["reason"]).length > 0), "the null userOpHash carries a reason");
  check(chain["unknowns"].some((entry: Record<string, any>) => entry["field"] === "chain.l1BatchReference" && String(entry["reason"]).length > 0), "the null L1 batch reference carries a reason");
  const unknownFields = (chain["unknowns"] as Array<Record<string, any>>).map((entry) => String(entry["field"]));
  check(new Set(unknownFields).size === unknownFields.length, "the unknown-field list is deduplicated");
  check(evidence["canonicalBlock"]["number"] === chain["canonicalBlockNumber"] && evidence["canonicalBlock"]["hash"] === chain["canonicalBlockHash"], "the canonical block matches the pack");

  const comparisons = evidence["comparisons"] as Array<Record<string, any>>;
  check(comparisons.length >= 4 && comparisons.every((entry) => entry["matched"] === true), "investor, dealer, fee, issuer and escrow balances match at the canonical block");
  check(comparisons.some((entry) => String(entry["label"]).startsWith("investor dEUR")) && comparisons.some((entry) => String(entry["label"]).startsWith("fee dEUR")) && comparisons.some((entry) => String(entry["label"]).startsWith("issuer dEUR")) && comparisons.some((entry) => String(entry["label"]).startsWith("escrow dEUR")), "the required account comparisons are present");
  check(evidence["ui"]["matchesApiPack"] === true && evidence["ui"]["receiptVisible"] === true, "the browser receipt exposed the pack and downloaded it byte-identically");
  check(evidence["ui"]["downloadedSha256"] === evidence["packSha256"], "the UI download digest equals the API pack digest");
  check((pack["costs"] as Array<Record<string, any>>).every((cost) => typeof cost["asOf"] === "string" && String(cost["asOf"]).length > 0), "every cost input is time-stamped");
  check(/^[0-9a-f]{64}$/.test(String(pack["manifest"]["packDigest"])), "the pack manifest digest is recorded");
  check(evidence["passed"] === true, "the S18 evidence records a pass");
  check((evidence["limitations"] as unknown[]).length >= 3, "limitations are recorded");

  if (failures.length > 0) {
    console.error("S18 settlement pack verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `S18 settlement pack verified: run ${String(evidence["run"]["runId"])}, pack digest ${String(pack["manifest"]["packDigest"]).slice(0, 12)}…, ` +
      `chain tx ${String(chain["txHash"]).slice(0, 10)}… log ${String(chain["logIndex"])} at canonical block ${String(chain["canonicalBlockNumber"])}, ` +
      `tamper exit ${String(evidence["verification"]["tampered"]["exitCode"])} with first mismatch`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
