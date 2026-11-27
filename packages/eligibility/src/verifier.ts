/**
 * Local eligibility receipt verification.
 *
 * A receipt is a cached approval bound to an account, gate, chain, class, epoch
 * and expiry. A root update invalidates earlier approvals at execution, so the
 * verifier always compares the receipt with the current issuer root and policy
 * context before a movement executes.
 */
import { classRank, meetsClass } from "./policy.js";
import { verifyEligibilityProof } from "./prover.js";
import type {
  EligibilityClass,
  EligibilityReceipt,
  ReceiptVerification,
  RootEpoch,
} from "./types.js";

export interface ReceiptExpectation {
  readonly chainId: number;
  readonly gateId: string;
  readonly gateAddress: string;
  readonly requiredClass: EligibilityClass;
  readonly currentRoot: RootEpoch;
  readonly clockIso: string;
}

export function checkReceiptFields(
  receipt: EligibilityReceipt,
  expected: ReceiptExpectation,
): string[] {
  const reasons: string[] = [];
  if (receipt.chainId !== expected.chainId) {
    reasons.push(`receipt chain ${receipt.chainId} is not ${expected.chainId}`);
  }
  if (receipt.gateId !== expected.gateId) {
    reasons.push(`receipt gate ${receipt.gateId} is not ${expected.gateId}`);
  }
  if (BigInt(receipt.publicInputs.gate) !== BigInt(expected.gateAddress)) {
    reasons.push("receipt gate address does not match the expected gate");
  }
  if (!meetsClass(receipt.class, expected.requiredClass)) {
    reasons.push(
      `receipt class ${receipt.class} does not satisfy ${expected.requiredClass} (rank ${classRank(receipt.class)})`,
    );
  }
  if (receipt.epoch !== expected.currentRoot.epoch) {
    reasons.push(`receipt epoch ${receipt.epoch} is not the current epoch ${expected.currentRoot.epoch}`);
  }
  if (receipt.root !== expected.currentRoot.root) {
    reasons.push("receipt root is not the current issuer root");
  }
  if (receipt.publicInputs.root !== expected.currentRoot.root) {
    reasons.push("receipt public root input does not match the current issuer root");
  }
  if (expected.clockIso > new Date(receipt.expiry * 1000).toISOString()) {
    reasons.push("the eligibility credential has expired");
  }
  if (receipt.publicInputs.expiry !== String(receipt.expiry)) {
    reasons.push("receipt expiry does not match its public input");
  }
  return reasons;
}

export async function verifyReceipt(
  receipt: EligibilityReceipt,
  expected: ReceiptExpectation,
): Promise<ReceiptVerification> {
  const fieldReasons = checkReceiptFields(receipt, expected);
  const started = Date.now();
  const proof = await verifyEligibilityProof({
    proofHex: receipt.proofHex,
    publicInputs: receipt.publicInputs,
  });
  const reasons = [...fieldReasons, ...proof.reasons];
  return {
    valid: reasons.length === 0 && proof.valid,
    reasons,
    verifyMs: Date.now() - started,
  };
}
