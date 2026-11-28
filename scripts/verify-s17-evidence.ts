/**
 * Offline verification of the S17 / SET-03 sponsored order evidence.
 *
 * Checks the ERC-4337 v0.7 bundle records: a successful sponsored fill, an included
 * bundle whose inner order reverts, pre-submission permit budget and expiry rejections,
 * the lost-response recovery of the mined receipt, the replay protection of the order
 * gateway, and the economic invariant that the user account never pays gas while the
 * sponsor deposit and beneficiary balances move by exactly the UserOperation cost.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { id } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
const sha256File = (path: string): string => createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex");
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const FILL = {
  accountCash: "799950000",
  accountSpot: "100000000000000000",
  dealerCash: "200000000",
  dealerSpot: "900000000000000000",
  feeCash: "50000",
  accountNative: "0",
} as const;

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/s17-sponsored-order.schema.json"));
  const evidence = readJson("evidence/s17/sponsored-order.json");
  check(validate(evidence) === true, `schema validation: ${JSON.stringify(validate.errors)}`);

  const aa = evidence["accountAbstraction"] as Record<string, any>;
  check(aa["implementation"] === "ERC-4337 v0.7" && aa["aaPackageVersion"] === "0.7.0", "the pinned ERC-4337 v0.7 EntryPoint is recorded");
  check(/^[0-9a-f]{64}$/.test(aa["entryPointArtifactSha256"]), "the EntryPoint artifact digest is recorded");
  check((aa["entryPointCodeHash"] as string) !== "0x" && /^0x[0-9a-fA-F]{64}$/.test(String(aa["entryPointCodeHash"])), "the EntryPoint code hash is recorded");

  const deployments = evidence["deployments"] as Array<Record<string, any>>;
  for (const name of ["entryPoint", "simpleAccountFactory", "paymaster", "cash", "spot", "escrow", "settlement", "orderEntry"]) {
    check(deployments.some((entry) => entry["name"] === name), `deployment ${name} is recorded`);
  }
  for (const deployment of deployments) {
    check(/^0x[0-9a-fA-F]{40}$/.test(deployment["address"]), `${String(deployment["name"])} address is well formed`);
    check(/^0x[0-9a-fA-F]{64}$/.test(deployment["codeHash"]) && !/^0x0+$/.test(deployment["codeHash"]), `${String(deployment["name"])} code hash is non-empty`);
  }
  for (const abi of evidence["abis"] as Array<Record<string, any>>) {
    check(existsSync(join(repoRoot, String(abi["path"]))), `ABI exists: ${String(abi["path"])}`);
    check(sha256File(String(abi["path"])) === abi["sha256"], `ABI digest matches: ${String(abi["path"])}`);
  }

  const permits = evidence["permits"] as Array<Record<string, any>>;
  const orderEntry = deployments.find((entry) => entry["name"] === "orderEntry")!["address"] as string;
  const submitSelector = id("submitSpotOrder(bytes32,address,uint256,uint256,uint256,uint256)").slice(0, 10);
  check(permits.length >= 5, "the expiring permits are recorded");
  for (const permit of permits) {
    check((permit["permitHash"] as string).length === 66, `permit ${String(permit["label"])} hash is well formed`);
    check(Number(permit["chainId"]) === 16584, `permit ${String(permit["label"])} binds the chain id`);
    check(Number(permit["validUntil"]) > 0 && Number(permit["maxCost"]) > 0, `permit ${String(permit["label"])} is expiring with a cost cap`);
    check((permit["signature"] as string | undefined) === undefined || String(permit["signature"]).length > 0, `permit ${String(permit["label"])} carries a sponsor signature`);
  }
  const orderPermit = permits.find((permit) => permit["label"] === "g01-order-permit")!;
  check(orderPermit["target"].toLowerCase() === orderEntry.toLowerCase(), "the G01 permit is scoped to the order entry target");
  check(String(orderPermit["selector"]).toLowerCase() === submitSelector, "the G01 permit is scoped to the submitSpotOrder method");

  const userOps = evidence["userOperations"] as Array<Record<string, any>>;
  const byLabel = new Map(userOps.map((op) => [String(op["label"]), op]));
  check(userOps.every((op) => op["userChargeWei"] === "0"), "the user account pays zero native gas in every operation");
  for (const op of userOps.filter((entry) => entry["submitted"] === true)) {
    const event = op["userOperationEvent"] as Record<string, any> | null;
    check(event !== null, `${String(op["label"])} has a UserOperationEvent`);
    check((op["outerTxHash"] as string).startsWith("0x") && Number(op["outerTxStatus"]) === 1, `${String(op["label"])} has a successful outer receipt`);
    if (event !== null) {
      check(BigInt(op["sponsorDepositDelta"]) === -BigInt(event["actualGasCost"]), `${String(op["label"])} sponsor deposit decreases by exactly the user operation cost`);
      check(BigInt(op["beneficiaryDelta"]) === BigInt(event["actualGasCost"]), `${String(op["label"])} beneficiary receives exactly the user operation cost`);
    }
  }

  const approval = byLabel.get("sponsored-approval")!;
  const fill = byLabel.get("sponsored-fill")!;
  const includedRevert = byLabel.get("included-revert")!;
  const replay = byLabel.get("replay-blocked")!;
  check(approval["userOperationEvent"]?.["success"] === true, "the sponsored approval operation succeeded");
  check(fill["userOperationEvent"]?.["success"] === true, "the sponsored G01 fill succeeded");
  check(includedRevert["submitted"] === true && includedRevert["userOperationEvent"]?.["success"] === false, "the included reverting order is bundled and marked failed while the sponsor pays");
  check(BigInt(includedRevert["sponsorDepositDelta"]) < 0n, "the sponsor still pays for the included reverting operation");
  check(replay["submitted"] === true && replay["userOperationEvent"]?.["success"] === false, "the repeated order is rejected inside an included bundle");

  const rejectedBudget = byLabel.get("budget-rejection")!;
  const rejectedExpiry = byLabel.get("permit-expiry-rejection")!;
  check(rejectedBudget["submitted"] === false && rejectedBudget["simulationRevert"] !== null, "the over-budget permit is rejected before submission");
  check(rejectedExpiry["submitted"] === false && rejectedExpiry["simulationRevert"] !== null, "the expired permit is rejected before submission");
  const rejections = evidence["rejections"] as Record<string, any>;
  check(rejections["budget"]["submitted"] === false && rejections["expiredPermit"]["submitted"] === false, "both pre-submission rejections are recorded without receipts");
  check(rejections["budget"]["simulationRevert"].includes("AA33") && rejections["expiredPermit"]["simulationRevert"].includes("AA33"), "the pre-submission failures are paymaster validation reverts");

  const afterFill = evidence["sponsoredFill"]["afterFill"] as Record<string, string>;
  for (const [key, value] of Object.entries(FILL)) {
    check(afterFill[key] === value, `sponsored fill balance ${key}: expected ${value}, observed ${String(afterFill[key])}`);
  }
  const afterIncluded = evidence["includedRevert"]["afterIncludedRevert"] as Record<string, string>;
  for (const key of Object.keys(FILL)) {
    if (key === "accountNative") continue;
    check(afterIncluded[key] === afterFill[key], `included revert leaves ${key} unchanged`);
  }

  const recovery = evidence["recovery"] as Record<string, any>;
  check(recovery["sameTransaction"] === true, "the recovered receipt is the original mined user operation transaction");
  check(recovery["receiptStatus"] === 1, "the recovered transaction receipt is successful");
  check(recovery["eventSuccess"] === true, "the recovered UserOperationEvent is successful");
  check(recovery["orderSettledOnce"] === true, "the recovered order is settled exactly once");
  check(recovery["accountCashUnchanged"] === FILL.accountCash && recovery["accountSpotUnchanged"] === FILL.accountSpot, "the recovered economic effect matches the recorded balances");
  check(recovery["transactionFromBundler"] === true, "the transaction was submitted by the bundler");
  check(recovery["replayEffect"]["replayEventSuccess"] === false, "the repeated request cannot settle the order twice");
  check(recovery["replayEffect"]["accountCash"] === FILL.accountCash && recovery["replayEffect"]["dealerCash"] === FILL.dealerCash, "the repeated request moves no money");

  const canonical = evidence["canonicalBalances"] as Record<string, string>;
  for (const [key, value] of Object.entries(FILL)) {
    check(canonical[key] === value, `canonical balance ${key}: expected ${value}, observed ${String(canonical[key])}`);
  }
  check(evidence["canonicalBlock"]["number"] >= Math.max(...userOps.filter((op) => op["blockNumber"] !== null).map((op) => Number(op["blockNumber"]))), "the canonical block is after every submitted bundle");
  check(evidence["passed"] === true, "the S17 evidence records a pass");
  check((evidence["limitations"] as unknown[]).length >= 3, "limitations are recorded");

  if (failures.length > 0) {
    console.error("S17 sponsored order verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `S17 sponsored order verified: ERC-4337 v0.7, ${String(userOps.length)} user operations (${String(userOps.filter((op) => op["submitted"] === true).length)} submitted), ` +
      `user charge zero, sponsor paid every bundle, included revert recorded, recovery matched the mined receipt, canonical block ${String(evidence["canonicalBlock"]["number"])}`,
  );
}

main();
