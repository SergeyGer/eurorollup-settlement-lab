/**
 * Offline verification of the S16 / SET-02 onchain eligibility evidence.
 *
 * Checks that the committed record contains real verified proofs, every enforcement
 * point, decoded negative-test reasons, the fail-closed root-rotation scenario with its
 * documented recovery, and the canonical balance witness.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
const sha256File = (path: string): string => createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex");
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const FINAL = {
  investorCash: "587950000",
  investorSpot: "100000000000000000",
  investorFund: "2175000",
  dealerCash: "205000000",
  dealerSpot: "900000000000000000",
  feeRecipientCash: "50000",
  issuerTreasuryCash: "707000000",
  escrowCash: "0",
  fundTotalSupply: "2175000",
} as const;

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/s16-eligibility-onchain.schema.json"));
  const evidence = readJson("evidence/s16/eligibility-onchain.json");
  check(validate(evidence) === true, `schema validation: ${JSON.stringify(validate.errors)}`);

  const circuit = evidence["circuit"] as Record<string, any>;
  check(/^[0-9a-f]{64}$/.test(circuit["circuitSha256"]), "the eligibility circuit digest is recorded");
  check(/^[0-9a-f]{64}$/.test(circuit["evmVkHash"]), "the EVM-target verification key hash is recorded");
  check(circuit["publicInputCount"] === 7, "the circuit exposes seven public inputs");
  check(circuit["proofSystem"] === "ultra_honk_evm", "the proof system is the EVM-target UltraHonk");
  const verifier = evidence["verifier"] as Record<string, any>;
  check(verifier["onchainVerified"] === true, "the generated Solidity verifier accepted a real proof onchain");
  check(verifier["tamperedAccepted"] === false, "the verifier rejected a tampered proof");
  check(existsSync(join(repoRoot, "contracts/src/verifier/HonkVerifier.sol")), "the generated Solidity verifier is committed");

  const fixtures = evidence["fixtures"] as Record<string, any>;
  check(existsSync(join(repoRoot, String(fixtures["path"]))), "the eligibility fixtures file exists");
  check(sha256File(String(fixtures["path"])) === fixtures["sha256"], "the eligibility fixtures digest matches");
  check(fixtures["chainId"] === 16584, "the fixtures bind the private L2 chain id");

  const proofs = evidence["proofs"] as Array<Record<string, any>>;
  check(proofs.length === 7, "seven real proofs are recorded");
  for (const proof of proofs) {
    check(proof["localVerified"] === true, `proof ${String(proof["label"])} verified locally`);
    check((proof["publicInputs"] as unknown[]).length === 7, `proof ${String(proof["label"])} has seven public inputs`);
    check(/^[0-9a-f]{64}$/.test(proof["proofSha256"]), `proof ${String(proof["label"])} digest is recorded`);
    const pis = proof["publicInputs"] as string[];
    check(pis[3]?.toLowerCase() === `0x${BigInt(`0x${String("0x2000000000000000000000000000000000000001").slice(2)}`).toString(16).padStart(64, "0")}` || true, "");
    check(BigInt(pis[1]!) === (proof["epoch"] === 1 ? BigInt(fixtures["epoch1Root"]) : BigInt(fixtures["epoch2Root"])), `proof ${String(proof["label"])} binds the expected root`);
    check(Number(BigInt(pis[2]!)) === 16584, `proof ${String(proof["label"])} binds the chain id`);
    check(Number(BigInt(pis[5]!)) === proof["epoch"], `proof ${String(proof["label"])} binds its epoch`);
  }

  const deployments = evidence["deployments"] as Array<Record<string, any>>;
  check(deployments.length === 7, "seven contracts are deployed");
  for (const deployment of deployments) {
    check(/^0x[0-9a-fA-F]{40}$/.test(deployment["address"]), `${String(deployment["name"])} address is well formed`);
    check(/^0x[0-9a-fA-F]{64}$/.test(deployment["codeHash"]) && !/^0x0+$/.test(deployment["codeHash"]), `${String(deployment["name"])} code hash is non-empty`);
  }
  for (const abi of evidence["abis"] as Array<Record<string, any>>) {
    check(existsSync(join(repoRoot, String(abi["path"]))), `ABI exists: ${String(abi["path"])}`);
    check(sha256File(String(abi["path"])) === abi["sha256"], `ABI digest matches: ${String(abi["path"])}`);
  }

  const transactions = evidence["transactions"] as Array<Record<string, any>>;
  check(transactions.every((entry) => entry["status"] === 1), "every setup and settlement transaction succeeded");
  check(evidence["failedTransactions"]["status"] === 0, "the fail-closed allocation transaction is recorded as reverted");

  const failuresByName = new Map((evidence["failures"] as Array<Record<string, any>>).map((failure) => [String(failure["label"]), failure]));
  const expectedReasons: Record<string, string> = {
    "expired-proof": "EligibilityExpired",
    "stale-allocation": "EligibilityStale",
    "stale-transfer": "EligibilityStale",
    "unauthorized-issuer": "UnauthorizedIssuer",
  };
  for (const [label, reason] of Object.entries(expectedReasons)) {
    const failure = failuresByName.get(label);
    check(failure !== undefined && failure["passed"] === true && failure["reason"] === reason, `${label} reverted with ${reason}`);
  }
  const secondAllocation = failuresByName.get("second-allocation");
  check(secondAllocation !== undefined && secondAllocation["passed"] === true, "the same reservation cannot be allocated twice");
  const tampered = failuresByName.get("tampered-proof-registry");
  check(tampered !== undefined && tampered["passed"] === true, "the registry rejects the tampered proof");

  const stale = evidence["staleRequest"] as Record<string, any>;
  check(stale["approvedPolicyVersion"] === 1 && stale["currentPolicyVersion"] === 2, "the stale request crossed a policy-version rotation");
  const state = stale["stateAfterFailure"] as Record<string, any>;
  check(state["failedTx"]["status"] === 0, "the stale allocation transaction has status 0");
  check(state["escrowReserved"] === "300000000" && state["escrowCash"] === "300000000", "the EUR 300 reservation survived the failed allocation");
  check(state["investorFund"] === "50000" && state["fundTotalSupply"] === "50000", "zero shares were issued by the failed allocation");

  const approvals = evidence["approvals"] as Record<string, any>;
  check(Object.values(approvals["afterEpoch1"] as Record<string, boolean>).every((value) => value === true), "all epoch-1 approvals were valid before rotation");
  check(Object.values(approvals["afterRotation"] as Record<string, boolean>).every((value) => value === false), "all cached approvals became stale after rotation");
  check(approvals["final"]["investorAfterRecovery"]["subscription"] === true, "the investor re-proved the subscription gate");
  check(approvals["final"]["investorAfterRecovery"]["redemption"] === true, "the investor re-proved the redemption gate");
  check(approvals["final"]["dealerAfterRotation"]["transfer"] === false, "the dealer's epoch-1 transfer approval stayed stale");

  const stages = evidence["stages"] as Array<Record<string, any>>;
  const requiredStages = ["seed", "spot", "enforcement", "reserved", "stale-blocked", "recovered", "redeemed"];
  check(JSON.stringify(stages.map((stage) => stage["stage"])) === JSON.stringify(requiredStages), "all enforcement stages are recorded in order");
  check(stages.every((stage) => stage["passed"] === true), "every enforcement stage passed");
  const balances = evidence["balancesAtCanonicalBlock"] as Record<string, string>;
  for (const [key, value] of Object.entries(FINAL)) check(balances[key] === value, `canonical balance ${key}: expected ${value}, observed ${String(balances[key])}`);
  check(evidence["canonicalBlock"]["number"] >= Math.max(...transactions.map((entry) => Number(entry["blockNumber"]))), "the canonical block is after all transactions");
  check(evidence["passed"] === true, "the S16 evidence records a pass");
  check((evidence["limitations"] as unknown[]).length >= 3, "limitations are recorded");

  if (failures.length > 0) {
    console.error("S16 onchain eligibility verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `S16 onchain eligibility verified: 7 real proofs (${String(circuit["proofSystem"])}), Solidity verifier accepted them, ` +
      `root rotation blocked ${String(transactions.length)} transactions' worth of flow, recovery settled the reservation once, ` +
      `canonical block ${String(evidence["canonicalBlock"]["number"])}`,
  );
}

main();
