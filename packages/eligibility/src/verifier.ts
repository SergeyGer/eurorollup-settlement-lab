/**
 * Local eligibility receipt verification.
 *
 * A receipt is a cached approval bound to an account, gate, chain, class, epoch
 * and expiry. A root update invalidates earlier approvals at execution, so the
 * verifier always compares the receipt with the current issuer root and policy
 * context before a movement executes.
 */
import { checkReceiptFields, type ReceiptExpectation } from "./receipt.js";
import { verifyEligibilityProof } from "./prover.js";
import type { EligibilityReceipt, ReceiptVerification } from "./types.js";

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
