/**
 * Offline verification of the S15 / SET-01 settlement slice evidence.
 *
 * Checks the committed deployment manifest and G01 run against the frozen expected
 * amounts: five deployed contracts with code hashes and ABI digests, a complete set of
 * successful stage transactions, per-stage expected == observed balances, and a canonical
 * block witness that matches the frozen final G01 portfolio.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const REQUIRED_STAGES = ["seed", "spot", "reserved", "allocated", "redeemed"];
const FINAL = {
  investorCash: "597950000",
  investorSpot: "100000000000000000",
  investorFund: "2125000",
  dealerCash: "200000000",
  dealerSpot: "900000000000000000",
  feeRecipientCash: "50000",
  issuerTreasuryCash: "702000000",
  escrowCash: "0",
  fundTotalSupply: "2125000",
} as const;

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/s15-settlement-slice.schema.json"));
  const evidence = readJson("evidence/s15/settlement-slice.json");
  check(validate(evidence) === true, `schema validation: ${JSON.stringify(validate.errors)}`);
  check(evidence["chains"]["l2ChainId"] === 16584 && evidence["chains"]["l1ChainId"] === 11155111, "the private L2 chain id and the L1 anchor are recorded");
  check(/^[0-9a-f]{40}$/.test(evidence["commit"]), "the source commit is recorded");

  const deployments = evidence["deployments"] as Array<Record<string, any>>;
  const expectedContracts = ["cash", "spot", "fund", "escrow", "settlement"];
  check(expectedContracts.every((name) => deployments.some((entry) => entry["name"] === name)), "all five contracts are deployed");
  for (const deployment of deployments) {
    check(/^0x[0-9a-fA-F]{40}$/.test(deployment["address"]), `${String(deployment["name"])} address is well formed`);
    check(/^0x[0-9a-fA-F]{64}$/.test(deployment["codeHash"]) && !/^0x0+$/.test(deployment["codeHash"]), `${String(deployment["name"])} deployed code hash is non-empty`);
    check(typeof deployment["blockNumber"] === "number" && deployment["blockNumber"] > 0, `${String(deployment["name"])} deployment block is recorded`);
  }
  for (const abi of evidence["abis"] as Array<Record<string, any>>) {
    const path = String(abi["path"]);
    check(existsSync(join(repoRoot, path)), `ABI file exists: ${path}`);
    check(sha256File(path) === abi["sha256"], `ABI digest matches: ${path}`);
  }

  const transactions = evidence["transactions"] as Array<Record<string, any>>;
  check(transactions.every((entry) => entry["status"] === 1), "every settlement transaction succeeded");
  check(transactions.length >= 10, "the full wiring, seed, approval and settlement transactions are recorded");
  check(transactions.every((entry) => /^0x[0-9a-fA-F]{64}$/.test(entry["txHash"])), "transaction hashes are well formed");
  for (const stage of ["spot", "reserved", "allocated", "redeemed"]) {
    check(transactions.some((entry) => entry["stage"] === stage), `stage ${stage} has a recorded transaction`);
  }

  const stages = evidence["stages"] as Array<Record<string, any>>;
  check(JSON.stringify(stages.map((stage) => stage["stage"])) === JSON.stringify(REQUIRED_STAGES), "stages are recorded in G01 order");
  for (const stage of stages) {
    check(stage["passed"] === true && (stage["mismatches"] as unknown[]).length === 0, `stage ${String(stage["stage"])} passed with no mismatches`);
    const expected = stage["expected"] as Record<string, string>;
    const observed = stage["observed"] as Record<string, string>;
    for (const key of Object.keys(expected)) {
      check(expected[key] === observed[key], `stage ${String(stage["stage"])} ${key}: expected ${String(expected[key])}, observed ${String(observed[key])}`);
    }
  }
  const canonicalBlock = evidence["canonicalBlock"];
  check(typeof canonicalBlock["number"] === "number" && /^0x[0-9a-fA-F]{64}$/.test(canonicalBlock["hash"]), "the canonical L2 block is recorded");
  check(canonicalBlock["number"] >= Math.max(...transactions.map((entry) => Number(entry["blockNumber"]))), "the canonical block is after the last settlement transaction");
  const balances = evidence["balancesAtCanonicalBlock"] as Record<string, string>;
  for (const [key, value] of Object.entries(FINAL)) {
    check(balances[key] === value, `canonical balance ${key}: expected ${value}, observed ${String(balances[key])}`);
  }
  const businessDigest = evidence["limits"]?.["businessDigest"];
  check(businessDigest === null || typeof businessDigest === "string", "unavailable business digest is recorded as null or a string");
  check((evidence["limitations"] as unknown[]).length >= 2, "limitations are recorded");
  check(evidence["passed"] === true, "the settlement slice records a pass");

  if (failures.length > 0) {
    console.error("S15 settlement slice verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `S15 settlement slice verified: 5 contracts, ${String(transactions.length)} transactions, stages ${REQUIRED_STAGES.join(" → ")}, ` +
      `canonical block ${String(canonicalBlock["number"])}, final investor cash ${FINAL.investorCash} base units, 2.125 eFUND`,
  );
}

main();
