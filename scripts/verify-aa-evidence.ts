/**
 * Offline verification of the committed A04 account-abstraction receipts.
 *
 * CI cannot start a local chain, so it verifies that the committed receipts are
 * internally consistent: three observed cases, hash presence matches inclusion,
 * the sponsor deposit moves exactly by the actual gas cost, the user charge is
 * zero for sponsored operations, and the exhausted sponsor leaves the deposit
 * untouched. The local scenario can be re-run with `pnpm aa:scenario`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = join(repoRoot, "evidence/a04/aa-receipts.json");

interface CaseEvidence {
  caseId: string;
  kind: string;
  userOpHashPresent: boolean;
  userOpHash: string;
  outerTxHash: string;
  outerTxStatus: number;
  gasUsed: string;
  blockNumber: number;
  userOperationEvent: {
    success: boolean;
    actualGasCost: string;
    actualGasUsed: string;
    nonce: string;
  } | null;
  userChargeBase: string;
  paymasterDepositBeforeBase: string;
  paymasterDepositAfterBase: string;
  paymasterDepositDeltaBase: string;
  sponsorPaid: boolean;
  permit: { validUntil: string; validAfter: string; verifyingSigner: string };
  revertReason: string | null;
  expected: {
    outerTxStatus: number;
    userOperationEvent: boolean;
    success: boolean | null;
    depositDeltaSign: string;
  };
  pass: boolean;
}

interface ReceiptsEvidence {
  schemaVersion: string;
  reportId: string;
  packId: string;
  generatedBy: string;
  chain: { chainId: number; rpc: string; runtime: string };
  contracts: {
    entryPoint: string;
    entryPointArtifact: string;
    accountFactory: string;
    account: string;
    paymaster: string;
    paymasterArtifact: string;
    bundler: string;
    beneficiary: string;
    sponsorSigner: string;
  };
  cases: CaseEvidence[];
  summary: { cases: number; passed: number; passedAll: boolean };
}

const errors: string[] = [];
const fail = (message: string): void => {
  errors.push(message);
};
const isHash = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);

function main(): void {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as ReceiptsEvidence;
  if (evidence.reportId !== "A04-aa-receipts") {
    fail("unexpected report id");
  }
  if (evidence.schemaVersion !== "1.0.0") {
    fail("unexpected schema version");
  }
  if (evidence.chain.chainId !== 31337) {
    fail("the local chain id must be 31337");
  }
  const addressFields = [
    "entryPoint",
    "accountFactory",
    "account",
    "paymaster",
    "bundler",
    "beneficiary",
    "sponsorSigner",
  ] as const;
  for (const name of addressFields) {
    try {
      getAddress(evidence.contracts[name]);
    } catch {
      fail(`contract address ${name} is invalid: ${evidence.contracts[name]}`);
    }
  }
  if (!evidence.contracts.entryPointArtifact.includes("@account-abstraction/contracts@0.7.0")) {
    fail("the pinned EntryPoint artifact version is not recorded");
  }
  if (!evidence.contracts.paymasterArtifact.includes("@account-abstraction/contracts@0.7.0")) {
    fail("the pinned paymaster artifact version is not recorded");
  }
  if (evidence.cases.length !== 3) {
    fail(`expected 3 observed cases, got ${evidence.cases.length}`);
  }
  const byKind = new Map(evidence.cases.map((item) => [item.kind, item]));
  const successCase = byKind.get("sponsored-success");
  const failureCase = byKind.get("included-failure");
  const exhaustedCase = byKind.get("exhausted-sponsor");
  if (successCase === undefined || failureCase === undefined || exhaustedCase === undefined) {
    fail("expected sponsored-success, included-failure and exhausted-sponsor cases");
  }
  for (const item of evidence.cases) {
    if (!item.pass) {
      fail(`${item.caseId} did not pass its own expectation`);
    }
    if (item.userChargeBase !== "0") {
      fail(`${item.caseId} charges the user instead of the sponsor`);
    }
    if (!isHash(item.outerTxHash) || !isHash(item.userOpHash)) {
      fail(`${item.caseId} has a malformed transaction or UserOperation hash`);
    }
    if (Number.parseInt(item.gasUsed, 10) <= 0) {
      fail(`${item.caseId} was not included in a block with gas`);
    }
    if (item.permit.verifyingSigner.toLowerCase() !== evidence.contracts.sponsorSigner.toLowerCase()) {
      fail(`${item.caseId} permit is signed by the wrong sponsor`);
    }
    if (BigInt(item.permit.validUntil) <= 0n) {
      fail(`${item.caseId} permit does not expire`);
    }
  }
  if (successCase !== undefined) {
    if (successCase.outerTxStatus !== 1) fail("sponsored success transaction did not succeed");
    if (successCase.userOpHashPresent !== true || successCase.userOperationEvent === null) {
      fail("sponsored success has no UserOperationEvent");
    }
    if (successCase.userOperationEvent?.success !== true) {
      fail("sponsored success UserOperationEvent is not successful");
    }
    const cost = BigInt(successCase.userOperationEvent?.actualGasCost ?? "0");
    const delta = BigInt(successCase.paymasterDepositDeltaBase);
    if (cost <= 0n) fail("sponsored success has no sponsor cost");
    if (delta !== -cost) {
      fail("sponsored success deposit delta does not equal the actual gas cost");
    }
    if (successCase.sponsorPaid !== true) fail("sponsored success was not paid by the sponsor");
  }
  if (failureCase !== undefined) {
    if (failureCase.outerTxStatus !== 1) fail("included failure transaction did not succeed");
    if (failureCase.userOperationEvent === null || failureCase.userOperationEvent.success !== false) {
      fail("included failure did not report a failed inner call");
    }
    const cost = BigInt(failureCase.userOperationEvent?.actualGasCost ?? "0");
    if (cost <= 0n) fail("included failure must still cost the sponsor money");
    if (BigInt(failureCase.paymasterDepositDeltaBase) !== -cost) {
      fail("included failure deposit delta does not equal the actual gas cost");
    }
  }
  if (exhaustedCase !== undefined) {
    if (exhaustedCase.outerTxStatus !== 0) fail("exhausted sponsor bundle should revert");
    if (exhaustedCase.userOperationEvent !== null || exhaustedCase.userOpHashPresent) {
      fail("exhausted sponsor must not emit a UserOperationEvent");
    }
    if (BigInt(exhaustedCase.paymasterDepositDeltaBase) !== 0n) {
      fail("exhausted sponsor must leave the deposit untouched");
    }
    if (exhaustedCase.revertReason === null || exhaustedCase.revertReason.length === 0) {
      fail("exhausted sponsor should record the validation revert reason");
    }
    if (!/AA3[13]|paymaster/i.test(exhaustedCase.revertReason ?? "")) {
      fail(`exhausted sponsor revert reason is not a paymaster validation failure: ${exhaustedCase.revertReason}`);
    }
  }
  if (!evidence.summary.passedAll) {
    fail("evidence summary is not passing");
  }
  if (evidence.summary.passed !== evidence.cases.length) {
    fail("evidence summary passed count does not match the cases");
  }
  if (errors.length > 0) {
    console.error("FAIL A04 account-abstraction evidence");
    for (const message of errors) {
      console.error(`  - ${message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("OK   A04 account-abstraction receipts verified");
  for (const item of evidence.cases) {
    console.log(
      `  ${item.caseId} ${item.kind}: tx ${item.outerTxHash.slice(0, 12)}… · event ${item.userOperationEvent === null ? "absent" : `success=${item.userOperationEvent.success} cost=${item.userOperationEvent.actualGasCost}`} · deposit delta ${item.paymasterDepositDeltaBase}`,
    );
  }
}

main();
