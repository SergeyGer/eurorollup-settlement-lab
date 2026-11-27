/**
 * Cryptographic proof verification of the committed A03 positive vectors.
 *
 * The full negative-vector replay runs through `pnpm eligibility:verify`; this
 * test keeps one real verification in the test suite.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyEligibilityProof, type ProofVectorsEvidence } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("committed proof vector", () => {
  it("verifies the committed positive proof against its public inputs", async () => {
    const vectors = JSON.parse(
      readFileSync(`${repoRoot}evidence/a03/proof-vectors.json`, "utf8"),
    ) as ProofVectorsEvidence;
    const vector = vectors.positive[0];
    expect(vector?.proofHex).toBeDefined();
    expect(vector?.publicInputs).toBeDefined();
    const verification = await verifyEligibilityProof({
      proofHex: vector!.proofHex!,
      publicInputs: vector!.publicInputs!,
    });
    expect(verification.valid).toBe(true);
    expect(verification.reasons).toEqual([]);
  }, 30_000);
});
