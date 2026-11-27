/**
 * Eligibility policy, fixture, receipt and evidence tests.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLOCK_ISO,
  evaluateRootRotation,
  decideSponsorship,
  evaluateRoute,
  personaById,
  epochByNumber,
  gatesFixture,
  rootsFixture,
  personasFixture,
  screeningByParty,
  screeningFixture,
  classRank,
  meetsClass,
  checkReceiptFields,
  circuitMetadata,
  type EligibilityReceipt,
  type PolicyMatrixEvidence,
  type ProofVectorsEvidence,
} from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("eligibility fixtures", () => {
  it("commits three personas and class codes", () => {
    expect(personasFixture.leaves).toHaveLength(8);
    expect(personasFixture.classCodes).toEqual({ VERIFIED: 3, BASIC: 2, FLAGGED: 1 });
    expect(personaById("persona-verified")?.class).toBe("VERIFIED");
    expect(personaById("persona-basic")?.class).toBe("BASIC");
    expect(personaById("persona-flagged")?.class).toBe("FLAGGED");
  });

  it("publishes two roots with a complete tree", () => {
    expect(rootsFixture.epochs).toHaveLength(2);
    for (const epoch of rootsFixture.epochs) {
      expect(epoch.leaves).toHaveLength(8);
      expect(epoch.levels).toHaveLength(4);
      expect(epoch.levels[0]).toHaveLength(8);
      expect(epoch.levels[1]).toHaveLength(4);
      expect(epoch.levels[2]).toHaveLength(2);
      expect(epoch.levels[3]).toHaveLength(1);
      expect(epoch.levels[3]?.[0]).toBe(epoch.root);
    }
    expect(epochByNumber(1)?.root).not.toBe(epochByNumber(2)?.root);
    expect(epochByNumber(2)?.leaves.some((leaf) => leaf.personaId === "persona-verified")).toBe(false);
  });

  it("publishes four gates with required classes", () => {
    expect(gatesFixture.gates.map((gate) => gate.gateId)).toEqual([
      "SPOT_ROUTER",
      "FUND_SUBSCRIPTION",
      "FUND_REDEMPTION",
      "SHARE_TRANSFER",
    ]);
    expect(meetsClass("VERIFIED", "VERIFIED")).toBe(true);
    expect(meetsClass("BASIC", "VERIFIED")).toBe(false);
    expect(classRank("FLAGGED")).toBeLessThan(classRank("BASIC"));
  });
});

function routeDecision(personaId: string, route: Parameters<typeof evaluateRoute>[0]["route"]) {
  const persona = personaById(personaId)!;
  const gateId =
    route === "SPOT_BUY" || route === "SPOT_SELL" ? "SPOT_ROUTER" : route;
  const gate = gatesFixture.gates.find((item) => item.gateId === gateId)!;
  return evaluateRoute({
    route,
    persona,
    gate,
    screening: screeningByParty(persona.accountId),
    clockIso: CLOCK_ISO,
    screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
    sourceVersion: screeningFixture.sourceVersion,
    currentRoot: epochByNumber(1)!,
    receiptValid: true,
  });
}

describe("three personas and documented policy", () => {
  it("allows every route for the verified investor", () => {
    for (const route of ["SPOT_BUY", "SPOT_SELL", "FUND_SUBSCRIPTION", "FUND_REDEMPTION", "SHARE_TRANSFER"] as const) {
      const decision = routeDecision("persona-verified", route);
      expect(decision.decision).toBe("ALLOW");
      expect(decision.code).toBe("ALLOW");
    }
  });

  it("lets the basic investor use spot and redemption but not fund subscription or transfer", () => {
    expect(routeDecision("persona-basic", "SPOT_BUY").decision).toBe("ALLOW");
    expect(routeDecision("persona-basic", "FUND_REDEMPTION").decision).toBe("ALLOW");
    const subscription = routeDecision("persona-basic", "FUND_SUBSCRIPTION");
    expect(subscription.decision).toBe("DECLINE");
    expect(subscription.code).toBe("ELIGIBILITY_REQUIRED");
    expect(routeDecision("persona-basic", "SHARE_TRANSFER").decision).toBe("DECLINE");
  });

  it("blocks both managed routes for the flagged persona", () => {
    for (const route of ["SPOT_BUY", "FUND_SUBSCRIPTION"] as const) {
      const decision = routeDecision("persona-flagged", route);
      expect(decision.decision).toBe("DECLINE");
      expect(decision.code).toBe("SCREENING_DECLINED");
    }
  });

  it("holds stale, review, missing-proof and expired states instead of executing", () => {
    const verified = personaById("persona-verified")!;
    const gate = gatesFixture.gates.find((item) => item.gateId === "FUND_SUBSCRIPTION")!;
    const base = {
      route: "FUND_SUBSCRIPTION" as const,
      persona: verified,
      gate,
      clockIso: CLOCK_ISO,
      screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
      sourceVersion: screeningFixture.sourceVersion,
      currentRoot: epochByNumber(1)!,
      receiptValid: true,
    };
    expect(
      evaluateRoute({ ...base, screening: screeningFixture.specialCases["stale"] }).code,
    ).toBe("SCREENING_STALE");
    expect(
      evaluateRoute({ ...base, screening: screeningFixture.specialCases["ambiguous"] }).code,
    ).toBe("SCREENING_REVIEW");
    expect(evaluateRoute({ ...base, screening: screeningByParty(verified.accountId), receiptValid: null }).code).toBe(
      "ELIGIBILITY_UNAVAILABLE",
    );
    const expired = evaluateRoute({
      ...base,
      screening: screeningFixture.specialCases["freshAfterExpiry"],
      clockIso: "2026-12-02T00:00:00Z",
    });
    expect(expired.decision).toBe("HOLD");
    expect(expired.code).toBe("ELIGIBILITY_UNAVAILABLE");
  });

  it("holds reserved cash and mints no units when the root rotates before allocation", () => {
    const outcome = evaluateRootRotation({
      persona: personaById("persona-verified")!,
      requestEpoch: epochByNumber(1)!,
      currentRoot: epochByNumber(2)!,
      cashReservedBase: "300000000",
      custodyAccount: "fund-escrow",
    });
    expect(outcome.decision).toBe("HOLD");
    expect(outcome.code).toBe("POLICY_CHANGED");
    expect(outcome.cashReservedBase).toBe("300000000");
    expect(outcome.cashReleasedBase).toBe("0");
    expect(outcome.unitsMintedBase).toBe("0");
    expect(outcome.allowedActions).toEqual([
      "authorized_refund",
      "revalidate_with_current_proof",
    ]);
  });

  it("declines sponsorship independently and leaves holdings untouched", () => {
    const persona = personaById("persona-basic")!;
    const declined = decideSponsorship({
      persona,
      dailyBudgetUsedBase: "99000000000000000",
      dailyBudgetBase: "100000000000000000",
      nativeDepositBase: "50000000000000000",
      nativeCostCeilingBase: "3000000000000000",
    });
    expect(declined.sponsorship).toBe("DECLINED");
    expect(declined.code).toBe("SPONSOR_LIMIT");
    expect(declined.holdingsUntouched).toBe(true);
    const approved = decideSponsorship({
      persona,
      dailyBudgetUsedBase: "0",
      dailyBudgetBase: "100000000000000000",
      nativeDepositBase: "50000000000000000",
      nativeCostCeilingBase: "3000000000000000",
    });
    expect(approved.sponsorship).toBe("APPROVED");
  });
});

describe("receipt binding", () => {
  const receipt: EligibilityReceipt = {
    receiptId: "RCPT-1",
    personaId: "persona-verified",
    gateId: "FUND_SUBSCRIPTION",
    chainId: 31337,
    class: "VERIFIED",
    epoch: 1,
    expiry: 1795996800,
    wallet: "1",
    root: epochByNumber(1)!.root,
    proofDigest: "0".repeat(64),
    proofHex: "00",
    publicInputs: {
      wallet: "1",
      root: epochByNumber(1)!.root,
      chainId: "31337",
      gate: BigInt(gatesFixture.gates[1]!.address).toString(),
      classCode: "3",
      epoch: "1",
      expiry: "1795996800",
    },
    circuitVersion: "1.0.0",
    vkHash: circuitMetadata.vkHash,
    provingMs: 1,
    verifiedAt: CLOCK_ISO,
    source: "cli",
  };
  const expectation = {
    chainId: 31337,
    gateId: "FUND_SUBSCRIPTION",
    gateAddress: gatesFixture.gates[1]!.address,
    requiredClass: "VERIFIED" as const,
    currentRoot: epochByNumber(1)!,
    clockIso: CLOCK_ISO,
  };

  it("accepts a fully bound receipt", () => {
    expect(checkReceiptFields(receipt, expectation)).toEqual([]);
  });

  it("rejects wrong chain, gate, class, epoch, root and expired credentials", () => {
    expect(checkReceiptFields({ ...receipt, chainId: 1 }, expectation).length).toBeGreaterThan(0);
    expect(checkReceiptFields({ ...receipt, gateId: "SPOT_ROUTER" }, expectation).length).toBeGreaterThan(0);
    expect(checkReceiptFields({ ...receipt, class: "BASIC" }, expectation).length).toBeGreaterThan(0);
    expect(
      checkReceiptFields({ ...receipt, epoch: 2 }, expectation).length,
    ).toBeGreaterThan(0);
    expect(
      checkReceiptFields({ ...receipt, root: epochByNumber(2)!.root }, expectation).length,
    ).toBeGreaterThan(0);
    expect(
      checkReceiptFields(receipt, {
        ...expectation,
        clockIso: "2027-01-15T00:00:00Z",
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("committed A03 evidence", () => {
  it("matches the documented policy matrix", () => {
    const matrix = JSON.parse(
      readFileSync(`${repoRoot}evidence/a03/policy-matrix.json`, "utf8"),
    ) as PolicyMatrixEvidence;
    expect(matrix.reportId).toBe("A03-policy-matrix");
    expect(matrix.summary.passed).toBe(true);
    expect(matrix.matrix).toHaveLength(19);
    expect(matrix.matrix.every((row) => row.pass)).toBe(true);
    expect(matrix.assertions.every((assertion) => assertion.pass)).toBe(true);
    expect(matrix.assertions.map((assertion) => assertion.assertionId)).toContain(
      "A03-ASSERT-ROTATION-HOLD",
    );
    expect(matrix.rotation.unitsMintedBase).toBe("0");
  });

  it("matches the committed proof vectors and artifacts", () => {
    const vectors = JSON.parse(
      readFileSync(`${repoRoot}evidence/a03/proof-vectors.json`, "utf8"),
    ) as ProofVectorsEvidence;
    expect(vectors.reportId).toBe("A03-proof-vectors");
    expect(vectors.summary.passed).toBe(true);
    expect(vectors.positive).toHaveLength(3);
    expect(vectors.negative).toHaveLength(5);
    expect(vectors.positive.every((vector) => vector.pass && vector.verified)).toBe(true);
    expect(vectors.negative.every((vector) => vector.pass && !vector.verified)).toBe(true);
    const artifactSha = createHash("sha256")
      .update(readFileSync(`${repoRoot}packages/eligibility/artifacts/eligibility.json`))
      .digest("hex");
    const vkSha = createHash("sha256")
      .update(readFileSync(`${repoRoot}packages/eligibility/artifacts/vk`))
      .digest("hex");
    expect(vectors.circuit.circuitSha256).toBe(artifactSha);
    expect(vectors.circuit.vkSha256).toBe(vkSha);
    expect(circuitMetadata.vkHash).toBe(vectors.circuit.vkHash);
  });
});
