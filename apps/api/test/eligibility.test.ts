/**
 * Eligibility, proof, sponsorship and account-abstraction API tests.
 */
import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../src/evidence/harness.js";

describe("eligibility policy endpoints", () => {
  it("exposes the policy version, roots, gates and circuit metadata", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("GET", "/v1/eligibility/policy");
      expect(response.status).toBe(200);
      const policy = response.body as {
        policyVersion: string;
        personas: Array<{ personaId: string; class: string }>;
        epochs: Array<{ epoch: number; root: string }>;
        gates: Array<{ gateId: string; requiredClass: string }>;
        circuit: { vkHash: string; proofSystem: string; publicInputs: string[] };
        currentEpoch: number;
      };
      expect(policy.policyVersion).toBe("ELIG-POLICY-1.0.0");
      expect(policy.personas.map((persona) => persona.personaId)).toEqual([
        "persona-verified",
        "persona-basic",
        "persona-flagged",
      ]);
      expect(policy.epochs).toHaveLength(2);
      expect(policy.epochs[1]?.root).not.toBe(policy.epochs[0]?.root);
      expect(policy.gates.map((gate) => gate.gateId)).toContain("FUND_SUBSCRIPTION");
      expect(policy.circuit.proofSystem).toBe("ultra_honk");
      expect(policy.circuit.vkHash).toMatch(/^[0-9a-f]{64}$/);
      expect(policy.circuit.publicInputs).toHaveLength(7);
      expect(policy.currentEpoch).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("returns account decisions and the root-rotation hold", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("GET", "/v1/eligibility/accounts/investor-ada?epoch=1");
      expect(response.status).toBe(200);
      const view = response.body as {
        accountId: string;
        personaId: string;
        decisions: Array<{ route: string; decision: string; code: string }>;
        rotation: { requestEpoch: number; currentEpoch: number; code: string; decision: string } | null;
      };
      expect(view.accountId).toBe("investor-ada");
      expect(view.personaId).toBe("persona-verified");
      expect(view.decisions).toHaveLength(5);
      expect(view.rotation?.requestEpoch).toBe(1);
      expect(view.rotation?.currentEpoch).toBe(2);
      expect(view.rotation?.code).toBe("POLICY_CHANGED");
      expect(view.rotation?.decision).toBe("HOLD");
    } finally {
      await harness.close();
    }
  });

  it("reports the independent SPONSOR_LIMIT decline", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("GET", "/v1/sponsorship/status");
      expect(response.status).toBe(200);
      const status = response.body as {
        decision: { sponsorship: string; code: string; holdingsUntouched: boolean };
      };
      expect(status.decision.sponsorship).toBe("DECLINED");
      expect(status.decision.code).toBe("SPONSOR_LIMIT");
      expect(status.decision.holdingsUntouched).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("serves the recorded A04 sponsored UserOperations", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("GET", "/v1/account-abstraction/receipts");
      expect(response.status).toBe(200);
      const receipts = response.body as {
        chainId: number;
        cases: Array<{ kind: string; pass: boolean }>;
        summary: { passedAll: boolean };
      };
      expect(receipts.chainId).toBe(31337);
      expect(receipts.cases.map((item) => item.kind)).toEqual([
        "sponsored-success",
        "included-failure",
        "exhausted-sponsor",
      ]);
      expect(receipts.cases.every((item) => item.pass)).toBe(true);
      expect(receipts.summary.passedAll).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("eligibility proof endpoints", () => {
  async function generateProof(harness: Harness): Promise<{
    receipt: {
      proofHex: string;
      proofDigest: string;
      publicInputs: Record<string, string>;
      provingMs: number;
      circuitVersion: string;
      vkHash: string;
    };
    verified: boolean;
  }> {
    const response = await harness.inject("POST", "/v1/eligibility/proofs", {
      payload: { personaId: "persona-verified", epoch: 1, gateId: "FUND_SUBSCRIPTION" },
    });
    expect(response.status).toBe(201);
    return response.body as {
      receipt: {
        proofHex: string;
        proofDigest: string;
        publicInputs: Record<string, string>;
        provingMs: number;
        circuitVersion: string;
        vkHash: string;
      };
      verified: boolean;
    };
  }

  it("generates a real proof that verifies against its public inputs", async () => {
    const harness = await createHarness();
    try {
      const generated = await generateProof(harness);
      expect(generated.verified).toBe(true);
      expect(generated.receipt.proofDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(generated.receipt.proofHex.length).toBeGreaterThan(1000);
      expect(generated.receipt.publicInputs.root).toMatch(/^[0-9]+$/);
      expect(generated.receipt.provingMs).toBeGreaterThan(0);
      expect(generated.receipt.circuitVersion).toBe("1.0.0");
      const verification = await harness.inject("POST", "/v1/eligibility/proofs/verify", {
        payload: {
          proofHex: generated.receipt.proofHex,
          publicInputs: generated.receipt.publicInputs,
        },
      });
      expect(verification.status).toBe(200);
      expect((verification.body as { valid: boolean }).valid).toBe(true);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("rejects a proof against a different root", async () => {
    const harness = await createHarness();
    try {
      const generated = await generateProof(harness);
      const roots = await harness.inject("GET", "/v1/eligibility/policy");
      const policy = roots.body as { epochs: Array<{ epoch: number; root: string }> };
      const otherRoot = policy.epochs[1]?.root ?? "0";
      const verification = await harness.inject("POST", "/v1/eligibility/proofs/verify", {
        payload: {
          proofHex: generated.receipt.proofHex,
          publicInputs: { ...generated.receipt.publicInputs, root: otherRoot },
        },
      });
      expect(verification.status).toBe(200);
      expect((verification.body as { valid: boolean }).valid).toBe(false);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("refuses a proof request for a persona that the epoch does not contain", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("POST", "/v1/eligibility/proofs", {
        payload: { personaId: "persona-verified", epoch: 2, gateId: "FUND_SUBSCRIPTION" },
      });
      expect(response.status).toBe(422);
      expect((response.body as { error: { code: string } }).error.code).toBe("PROOF_UNAVAILABLE");
    } finally {
      await harness.close();
    }
  });
});

describe("managed order eligibility enforcement", () => {
  it("blocks a basic persona from a fund subscription before reserving cash", async () => {
    const harness = await createHarness();
    try {
      const portfolioBefore = await harness.getPortfolio("investor-cy");
      const before = portfolioBefore.body as {
        balances: { dEUR: { availableBase: string; reservedBase: string } };
      };
      const quote = await harness.createQuote({
        accountId: "investor-cy",
        assetId: "eFUND",
        side: "SUBSCRIBE",
        amountBase: "300000000",
      });
      expect(quote.status).toBe(200);
      const placed = await harness.placeOrder(
        (quote.body as { quoteId: string }).quoteId,
        "investor-cy",
        "idem-cy-fund",
      );
      expect(placed.status).toBe(422);
      expect((placed.body as { error: { code: string } }).error.code).toBe("ELIGIBILITY_REQUIRED");
      const portfolioAfter = await harness.getPortfolio("investor-cy");
      const after = portfolioAfter.body as {
        balances: { dEUR: { availableBase: string; reservedBase: string } };
      };
      expect(after.balances.dEUR.availableBase).toBe(before.balances.dEUR.availableBase);
      expect(after.balances.dEUR.reservedBase).toBe("0");
    } finally {
      await harness.close();
    }
  });

  it("blocks a flagged persona from a managed spot route", async () => {
    const harness = await createHarness();
    try {
      const quote = await harness.createQuote({
        accountId: "investor-dee",
        assetId: "tWETH",
        side: "BUY",
        amountBase: "200000000",
      });
      expect(quote.status).toBe(200);
      const placed = await harness.placeOrder(
        (quote.body as { quoteId: string }).quoteId,
        "investor-dee",
        "idem-dee-spot",
      );
      expect(placed.status).toBe(403);
      expect((placed.body as { error: { code: string } }).error.code).toBe("SCREENING_DECLINED");
    } finally {
      await harness.close();
    }
  });

  it("still accepts a verified investor's fund subscription", async () => {
    const harness = await createHarness();
    try {
      const quote = await harness.createQuote({
        accountId: "investor-ada",
        assetId: "eFUND",
        side: "SUBSCRIBE",
        amountBase: "300000000",
      });
      const placed = await harness.placeOrder(
        (quote.body as { quoteId: string }).quoteId,
        "investor-ada",
        "idem-ada-fund-eligibility",
      );
      expect(placed.status).toBe(202);
    } finally {
      await harness.close();
    }
  });
});
