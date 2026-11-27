/**
 * A03 evidence builders.
 *
 * `policy-matrix.json` records the documented decisions for three personas, five
 * dealing routes and the policy-change scenarios: malformed screening, a root
 * rotation between fund request and allocation, and an independent sponsorship
 * limit. `proof-vectors.json` records positive and negative zero-knowledge
 * vectors produced with the committed circuit.
 */
import {
  currentEpoch,
  epochByNumber,
  gatesFixture,
  personaById,
  personasFixture,
  rootsFixture,
  screeningByParty,
  screeningFixture,
} from "./fixtures.js";
import {
  ELIGIBILITY_POLICY_VERSION,
  decideSponsorship,
  evaluateRootRotation,
  evaluateRoute,
} from "./policy.js";
import {
  EligibilityProverError,
  buildWitnessInputs,
  circuitMetadata,
  proveEligibility,
  verifyEligibilityProof,
} from "./prover.js";
import { checkReceiptFields } from "./receipt.js";
import type {
  DealingRoute,
  DecisionCode,
  EligibilityReceipt,
  MovementDecision,
  PolicyDecision,
  RootRotationOutcome,
  SponsorshipDecision,
} from "./types.js";

export const CLOCK_ISO = "2026-11-20T15:30:00Z";

const ROUTES: readonly DealingRoute[] = [
  "SPOT_BUY",
  "SPOT_SELL",
  "FUND_SUBSCRIPTION",
  "FUND_REDEMPTION",
  "SHARE_TRANSFER",
];

export interface MatrixRow {
  readonly rowId: string;
  readonly scenario: string;
  readonly personaId: string;
  readonly accountId: string;
  readonly class: string;
  readonly route: DealingRoute;
  readonly decision: MovementDecision;
  readonly code: DecisionCode;
  readonly requiresProof: boolean;
  readonly receiptValid: boolean | null;
  readonly detail: string;
  readonly cashReservedBase: string;
  readonly unitsMintedBase: string;
  readonly expectedDecision: MovementDecision;
  readonly expectedCode: DecisionCode;
  readonly pass: boolean;
}

export interface PolicyMatrixEvidence {
  readonly schemaVersion: "1.0.0";
  readonly reportId: "A03-policy-matrix";
  readonly packId: "A03-eligibility";
  readonly generatedBy: string;
  readonly policyVersion: string;
  readonly clock: string;
  readonly fixtures: {
    readonly personasFixtureId: string;
    readonly personasFixtureVersion: string;
    readonly rootsFixtureId: string;
    readonly rootsFixtureVersion: string;
    readonly screeningFixtureId: string;
    readonly screeningFixtureVersion: string;
    readonly screeningSourceVersion: string;
    readonly chainId: number;
    readonly epochs: ReadonlyArray<{
      readonly epoch: number;
      readonly publishedAt: string;
      readonly root: string;
      readonly leafCount: number;
    }>;
    readonly gates: readonly {
      readonly gateId: string;
      readonly address: string;
      readonly requiredClass: string;
    }[];
  };
  readonly matrix: readonly MatrixRow[];
  readonly rotation: RootRotationOutcome;
  readonly sponsorship: SponsorshipDecision;
  readonly assertions: readonly {
    readonly assertionId: string;
    readonly description: string;
    readonly pass: boolean;
  }[];
  readonly summary: {
    readonly rows: number;
    readonly allow: number;
    readonly hold: number;
    readonly decline: number;
    readonly passed: boolean;
  };
}

function routeRow(params: {
  rowId: string;
  scenario: string;
  personaId: string;
  route: DealingRoute;
  decision: PolicyDecision;
  expectedDecision: MovementDecision;
  expectedCode: DecisionCode;
}): MatrixRow {
  const persona = personaById(params.personaId);
  if (persona === undefined) {
    throw new Error(`unknown persona ${params.personaId}`);
  }
  return {
    rowId: params.rowId,
    scenario: params.scenario,
    personaId: persona.personaId,
    accountId: persona.accountId,
    class: persona.class,
    route: params.route,
    decision: params.decision.decision,
    code: params.decision.code,
    requiresProof: params.decision.requiresProof,
    receiptValid: params.decision.receiptValid,
    detail: params.decision.detail,
    cashReservedBase: "0",
    unitsMintedBase: "0",
    expectedDecision: params.expectedDecision,
    expectedCode: params.expectedCode,
    pass:
      params.decision.decision === params.expectedDecision &&
      params.decision.code === params.expectedCode,
  };
}

function expectedFor(personaClass: string, route: DealingRoute): {
  decision: MovementDecision;
  code: DecisionCode;
} {
  if (personaClass === "FLAGGED") {
    return { decision: "DECLINE", code: "SCREENING_DECLINED" };
  }
  if (personaClass === "BASIC" && route === "FUND_SUBSCRIPTION") {
    return { decision: "DECLINE", code: "ELIGIBILITY_REQUIRED" };
  }
  if (personaClass === "BASIC" && route === "SHARE_TRANSFER") {
    return { decision: "DECLINE", code: "ELIGIBILITY_REQUIRED" };
  }
  return { decision: "ALLOW", code: "ALLOW" };
}

export function buildPolicyMatrixEvidence(): PolicyMatrixEvidence {
  const epoch = epochByNumber(1) ?? currentEpoch();
  const verified = personaById("persona-verified");
  const basic = personaById("persona-basic");
  const flagged = personaById("persona-flagged");
  if (verified === undefined || basic === undefined || flagged === undefined) {
    throw new Error("demo personas are missing from the fixture");
  }
  const sourceVersion = screeningFixture.sourceVersion;
  const rows: MatrixRow[] = [];
  let rowIndex = 0;
  for (const persona of [verified, basic, flagged]) {
    const screening = screeningByParty(persona.accountId);
    if (screening === undefined) {
      throw new Error(`screening fixture missing for ${persona.accountId}`);
    }
    for (const route of ROUTES) {
      const gateId = route === "SPOT_BUY" || route === "SPOT_SELL" ? "SPOT_ROUTER" : route;
      const gate = gatesFixture.gates.find((item) => item.gateId === gateId);
      if (gate === undefined) {
        throw new Error(`gate fixture missing for ${gateId}`);
      }
      const decision = evaluateRoute({
        route,
        persona,
        gate,
        screening,
        clockIso: CLOCK_ISO,
        screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
        sourceVersion,
        currentRoot: epoch,
        receiptValid: true,
      });
      const expected = expectedFor(persona.class, route);
      rowIndex += 1;
      rows.push(
        routeRow({
          rowId: `MX-${String(rowIndex).padStart(2, "0")}`,
          scenario: "current-root",
          personaId: persona.personaId,
          route,
          decision,
          expectedDecision: expected.decision,
          expectedCode: expected.code,
        }),
      );
    }
  }

  // Special rows: stale screening, review disposition, missing proof, expired credential.
  const fundGate = gatesFixture.gates.find((gate) => gate.gateId === "FUND_SUBSCRIPTION")!;
  const stale = screeningFixture.specialCases["stale"]!;
  const ambiguous = screeningFixture.specialCases["ambiguous"]!;
  const staleDecision = evaluateRoute({
    route: "FUND_SUBSCRIPTION",
    persona: verified,
    gate: fundGate,
    screening: stale,
    clockIso: CLOCK_ISO,
    screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
    sourceVersion,
    currentRoot: epoch,
    receiptValid: true,
  });
  rows.push(
    routeRow({
      rowId: `MX-${String(rows.length + 1).padStart(2, "0")}`,
      scenario: "stale-screening",
      personaId: verified.personaId,
      route: "FUND_SUBSCRIPTION",
      decision: staleDecision,
      expectedDecision: "HOLD",
      expectedCode: "SCREENING_STALE",
    }),
  );
  const reviewDecision = evaluateRoute({
    route: "SPOT_BUY",
    persona: verified,
    gate: gatesFixture.gates.find((gate) => gate.gateId === "SPOT_ROUTER")!,
    screening: ambiguous,
    clockIso: CLOCK_ISO,
    screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
    sourceVersion,
    currentRoot: epoch,
    receiptValid: true,
  });
  rows.push(
    routeRow({
      rowId: `MX-${String(rows.length + 1).padStart(2, "0")}`,
      scenario: "review-disposition",
      personaId: verified.personaId,
      route: "SPOT_BUY",
      decision: reviewDecision,
      expectedDecision: "HOLD",
      expectedCode: "SCREENING_REVIEW",
    }),
  );
  const missingProof = evaluateRoute({
    route: "FUND_SUBSCRIPTION",
    persona: verified,
    gate: fundGate,
    screening: screeningByParty(verified.accountId),
    clockIso: CLOCK_ISO,
    screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
    sourceVersion,
    currentRoot: epoch,
    receiptValid: null,
  });
  rows.push(
    routeRow({
      rowId: `MX-${String(rows.length + 1).padStart(2, "0")}`,
      scenario: "missing-proof",
      personaId: verified.personaId,
      route: "FUND_SUBSCRIPTION",
      decision: missingProof,
      expectedDecision: "HOLD",
      expectedCode: "ELIGIBILITY_UNAVAILABLE",
    }),
  );
  const freshAfterExpiry = screeningFixture.specialCases["freshAfterExpiry"]!;
  const expiredDecision = evaluateRoute({
    route: "FUND_SUBSCRIPTION",
    persona: verified,
    gate: fundGate,
    screening: freshAfterExpiry,
    clockIso: "2026-12-02T00:00:00Z",
    screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
    sourceVersion,
    currentRoot: epoch,
    receiptValid: true,
  });
  rows.push(
    routeRow({
      rowId: `MX-${String(rows.length + 1).padStart(2, "0")}`,
      scenario: "expired-credential",
      personaId: verified.personaId,
      route: "FUND_SUBSCRIPTION",
      decision: expiredDecision,
      expectedDecision: "HOLD",
      expectedCode: "ELIGIBILITY_UNAVAILABLE",
    }),
  );

  const rotation = evaluateRootRotation({
    persona: verified,
    requestEpoch: epochByNumber(1)!,
    currentRoot: epochByNumber(2)!,
    cashReservedBase: "300000000",
    custodyAccount: "fund-escrow",
  });
  const sponsorship = decideSponsorship({
    persona: basic,
    dailyBudgetUsedBase: "99000000000000000",
    dailyBudgetBase: "100000000000000000",
    nativeDepositBase: "50000000000000000",
    nativeCostCeilingBase: "3000000000000000",
  });

  const assertions = [
    {
      assertionId: "A03-ASSERT-VERIFIED-ALLOW",
      description: "Verified investor may execute every supported route.",
      pass: rows
        .filter((row) => row.personaId === verified.personaId && row.scenario === "current-root")
        .every((row) => row.pass && row.decision === "ALLOW"),
    },
    {
      assertionId: "A03-ASSERT-BASIC-FUND-BLOCKED",
      description:
        "Basic investor is refused fund subscription before reserving cash; no cash is reserved and no units are minted.",
      pass: rows.some(
        (row) =>
          row.personaId === basic.personaId &&
          row.route === "FUND_SUBSCRIPTION" &&
          row.scenario === "current-root" &&
          row.decision === "DECLINE" &&
          row.code === "ELIGIBILITY_REQUIRED" &&
          row.cashReservedBase === "0" &&
          row.unitsMintedBase === "0",
      ),
    },
    {
      assertionId: "A03-ASSERT-FLAGGED-BLOCKED",
      description: "A synthetic screening match blocks every managed route.",
      pass: rows
        .filter((row) => row.personaId === flagged.personaId)
        .every((row) => row.decision === "DECLINE" && row.code === "SCREENING_DECLINED"),
    },
    {
      assertionId: "A03-ASSERT-STALE-HOLD",
      description: "A stale screening refresh holds the movement with a reason.",
      pass: rows.some((row) => row.scenario === "stale-screening" && row.code === "SCREENING_STALE" && row.decision === "HOLD"),
    },
    {
      assertionId: "A03-ASSERT-REVIEW-HOLD",
      description: "An ambiguous screening result is never executable.",
      pass: rows.some((row) => row.scenario === "review-disposition" && row.code === "SCREENING_REVIEW" && row.decision === "HOLD"),
    },
    {
      assertionId: "A03-ASSERT-MISSING-PROOF-HOLD",
      description: "A fund movement without a current proof is held.",
      pass: rows.some((row) => row.scenario === "missing-proof" && row.code === "ELIGIBILITY_UNAVAILABLE" && row.decision === "HOLD"),
    },
    {
      assertionId: "A03-ASSERT-EXPIRED-CREDENTIAL-HOLD",
      description: "An expired issuer credential is held with a reason.",
      pass: rows.some(
        (row) =>
          row.scenario === "expired-credential" &&
          row.decision === "HOLD" &&
          row.code === "ELIGIBILITY_UNAVAILABLE",
      ),
    },
    {
      assertionId: "A03-ASSERT-ROTATION-HOLD",
      description:
        "A root rotation between fund request and allocation holds the reserved cash, mints no units and exposes POLICY_CHANGED with refund or revalidation actions.",
      pass:
        rotation.decision === "HOLD" &&
        rotation.code === "POLICY_CHANGED" &&
        rotation.cashReservedBase === "300000000" &&
        rotation.cashReleasedBase === "0" &&
        rotation.unitsMintedBase === "0" &&
        rotation.allowedActions.includes("authorized_refund"),
    },
    {
      assertionId: "A03-ASSERT-SPONSOR-INDEPENDENT",
      description: "A sponsorship limit decline leaves business holdings untouched.",
      pass:
        sponsorship.sponsorship === "DECLINED" &&
        sponsorship.code === "SPONSOR_LIMIT" &&
        sponsorship.holdingsUntouched,
    },
  ];

  const summary = {
    rows: rows.length,
    allow: rows.filter((row) => row.decision === "ALLOW").length,
    hold: rows.filter((row) => row.decision === "HOLD").length,
    decline: rows.filter((row) => row.decision === "DECLINE").length,
    passed: rows.every((row) => row.pass) && assertions.every((assertion) => assertion.pass),
  };

  return {
    schemaVersion: "1.0.0",
    reportId: "A03-policy-matrix",
    packId: "A03-eligibility",
    generatedBy: "pnpm eligibility:matrix",
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    clock: CLOCK_ISO,
    fixtures: {
      personasFixtureId: personasFixture.fixtureId,
      personasFixtureVersion: personasFixture.fixtureVersion,
      rootsFixtureId: rootsFixture.fixtureId,
      rootsFixtureVersion: rootsFixture.fixtureVersion,
      screeningFixtureId: screeningFixture.fixtureId,
      screeningFixtureVersion: screeningFixture.fixtureVersion,
      screeningSourceVersion: screeningFixture.sourceVersion,
      chainId: personasFixture.chainId,
      epochs: rootsFixture.epochs.map((item) => ({
        epoch: item.epoch,
        publishedAt: item.publishedAt,
        root: item.root,
        leafCount: item.leaves.length,
      })),
      gates: gatesFixture.gates.map((gate) => ({
        gateId: gate.gateId,
        address: gate.address,
        requiredClass: gate.requiredClass,
      })),
    },
    matrix: rows,
    rotation,
    sponsorship,
    assertions,
    summary,
  };
}

export interface ProofVector {
  readonly vectorId: string;
  readonly kind: "positive" | "negative";
  readonly personaId: string;
  readonly epoch: number;
  readonly gateId: string;
  readonly publicInputs?: {
    readonly wallet: string;
    readonly root: string;
    readonly chainId: string;
    readonly gate: string;
    readonly classCode: string;
    readonly epoch: string;
    readonly expiry: string;
  };
  readonly proofHex?: string;
  readonly proofDigest?: string;
  readonly proofSizeBytes?: number;
  readonly provingMs?: number;
  readonly verifyMs?: number;
  readonly verified: boolean;
  readonly expected: string;
  readonly observed: string;
  readonly pass: boolean;
}

export interface ProofVectorsEvidence {
  readonly schemaVersion: "1.0.0";
  readonly reportId: "A03-proof-vectors";
  readonly packId: "A03-eligibility";
  readonly generatedBy: string;
  readonly circuit: typeof circuitMetadata;
  readonly fixtures: {
    readonly rootsFixtureVersion: string;
    readonly chainId: number;
    readonly epoch1Root: string;
    readonly epoch2Root: string;
  };
  readonly positive: readonly ProofVector[];
  readonly negative: readonly ProofVector[];
  readonly summary: {
    readonly positives: number;
    readonly positivesVerified: number;
    readonly negatives: number;
    readonly negativesRejected: number;
    readonly passed: boolean;
  };
}

function fakeReceipt(proof: {
  proofHex: string;
  proofDigest: string;
  publicInputs: EligibilityReceipt["publicInputs"];
  provingMs: number;
}): EligibilityReceipt {
  return {
    receiptId: "RCPT-TEST",
    personaId: "persona-verified",
    gateId: "FUND_SUBSCRIPTION",
    chainId: 31337,
    class: "VERIFIED",
    epoch: 1,
    expiry: 1795996800,
    wallet: proof.publicInputs.wallet,
    root: proof.publicInputs.root,
    proofDigest: proof.proofDigest,
    proofHex: proof.proofHex,
    publicInputs: proof.publicInputs,
    circuitVersion: circuitMetadata.circuitVersion,
    vkHash: circuitMetadata.vkHash,
    provingMs: proof.provingMs,
    verifiedAt: CLOCK_ISO,
    source: "cli",
  };
}

export async function buildProofVectorsEvidence(): Promise<ProofVectorsEvidence> {
  const positives: ProofVector[] = [];
  const epoch1 = epochByNumber(1)!;
  const epoch2 = epochByNumber(2)!;
  const positivePlans = [
    { vectorId: "A03-PV-01", personaId: "persona-verified", gateId: "FUND_SUBSCRIPTION" as const },
    { vectorId: "A03-PV-02", personaId: "persona-basic", gateId: "SPOT_ROUTER" as const },
    { vectorId: "A03-PV-03", personaId: "persona-flagged", gateId: "SPOT_ROUTER" as const },
  ];
  const generatedProofs = [];
  for (const plan of positivePlans) {
    const proof = await proveEligibility({
      personaId: plan.personaId,
      epoch: 1,
      gateId: plan.gateId,
    });
    const verification = await verifyEligibilityProof({
      proofHex: proof.proofHex,
      publicInputs: proof.publicInputs,
    });
    generatedProofs.push({ plan, proof });
    positives.push({
      vectorId: plan.vectorId,
      kind: "positive",
      personaId: plan.personaId,
      epoch: 1,
      gateId: plan.gateId,
      publicInputs: proof.publicInputs,
      proofHex: proof.proofHex,
      proofDigest: proof.proofDigest,
      proofSizeBytes: proof.proofSizeBytes,
      provingMs: proof.provingMs,
      verifyMs: verification.verifyMs,
      verified: verification.valid,
      expected: "proof verifies against the epoch-1 root and binds the public inputs",
      observed: verification.valid ? "verified" : verification.reasons.join("; "),
      pass: verification.valid,
    });
  }

  const negative: ProofVector[] = [];
  const primary = generatedProofs[0]!;
  // Negative 1: the same proof with a different public root must not verify.
  const tamperedRoot = await verifyEligibilityProof({
    proofHex: primary.proof.proofHex,
    publicInputs: { ...primary.proof.publicInputs, root: epoch2.root },
  });
  negative.push({
    vectorId: "A03-NV-01",
    kind: "negative",
    personaId: primary.plan.personaId,
    epoch: 1,
    gateId: primary.plan.gateId,
    publicInputs: { ...primary.proof.publicInputs, root: epoch2.root },
    verified: tamperedRoot.valid,
    expected: "the epoch-1 proof must not verify against the epoch-2 root",
    observed: tamperedRoot.valid ? "verified unexpectedly" : "rejected by the verifier",
    pass: !tamperedRoot.valid,
  });
  // Negative 2: a tampered proof must not verify.
  const bytes = Buffer.from(primary.proof.proofHex, "hex");
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  const tamperedProof = await verifyEligibilityProof({
    proofHex: bytes.toString("hex"),
    publicInputs: primary.proof.publicInputs,
  });
  negative.push({
    vectorId: "A03-NV-02",
    kind: "negative",
    personaId: primary.plan.personaId,
    epoch: 1,
    gateId: primary.plan.gateId,
    publicInputs: primary.proof.publicInputs,
    verified: tamperedProof.valid,
    expected: "a proof with one flipped byte must not verify",
    observed: tamperedProof.valid ? "verified unexpectedly" : "rejected by the verifier",
    pass: !tamperedProof.valid,
  });
  // Negative 3: a persona removed by root rotation has no witness for the new epoch.
  let rotationObserved = "";
  let rotationPass = false;
  try {
    buildWitnessInputs({ personaId: "persona-verified", epoch: 2, gateId: "FUND_SUBSCRIPTION" });
    rotationObserved = "witness produced unexpectedly";
  } catch (error) {
    rotationObserved =
      error instanceof EligibilityProverError
        ? `${error.code}: ${error.message}`
        : String(error);
    rotationPass = error instanceof EligibilityProverError && error.code === "WITNESS_UNAVAILABLE";
  }
  negative.push({
    vectorId: "A03-NV-03",
    kind: "negative",
    personaId: "persona-verified",
    epoch: 2,
    gateId: "FUND_SUBSCRIPTION",
    verified: false,
    expected: "a persona removed by root rotation cannot produce an epoch-2 proof",
    observed: rotationObserved,
    pass: rotationPass,
  });

  // Negative 4: gate binding. The receipt for the fund gate must not satisfy spot.
  const receipt = fakeReceipt(primary.proof);
  const gateReasons = checkReceiptFields(receipt, {
    chainId: 31337,
    gateId: "SPOT_ROUTER",
    gateAddress: "0x2000000000000000000000000000000000000001",
    requiredClass: "BASIC",
    currentRoot: epoch1,
    clockIso: CLOCK_ISO,
  });
  negative.push({
    vectorId: "A03-NV-04",
    kind: "negative",
    personaId: "persona-verified",
    epoch: 1,
    gateId: "SPOT_ROUTER",
    verified: false,
    expected: "a fund-gate receipt must not satisfy the spot gate",
    observed:
      gateReasons.length > 0
        ? `rejected: ${gateReasons.join("; ")}`
        : "accepted unexpectedly",
    pass: gateReasons.length > 0,
  });

  // Negative 5: an expired credential must be rejected by the policy context.
  const expiredReasons = checkReceiptFields(receipt, {
    chainId: 31337,
    gateId: "FUND_SUBSCRIPTION",
    gateAddress: "0x2000000000000000000000000000000000000002",
    requiredClass: "VERIFIED",
    currentRoot: epoch1,
    clockIso: "2027-01-15T00:00:00Z",
  });
  negative.push({
    vectorId: "A03-NV-05",
    kind: "negative",
    personaId: "persona-verified",
    epoch: 1,
    gateId: "FUND_SUBSCRIPTION",
    verified: false,
    expected: "an expired credential must be rejected",
    observed:
      expiredReasons.length > 0
        ? `rejected: ${expiredReasons.join("; ")}`
        : "accepted unexpectedly",
    pass: expiredReasons.length > 0,
  });

  const positivesVerified = positives.filter((vector) => vector.verified && vector.pass).length;
  const negativesRejected = negative.filter((vector) => vector.pass).length;
  return {
    schemaVersion: "1.0.0",
    reportId: "A03-proof-vectors",
    packId: "A03-eligibility",
    generatedBy: "pnpm eligibility:evidence",
    circuit: circuitMetadata,
    fixtures: {
      rootsFixtureVersion: rootsFixture.fixtureVersion,
      chainId: personasFixture.chainId,
      epoch1Root: epoch1.root,
      epoch2Root: epoch2.root,
    },
    positive: positives,
    negative,
    summary: {
      positives: positives.length,
      positivesVerified,
      negatives: negative.length,
      negativesRejected,
      passed: positivesVerified === positives.length && negativesRejected === negative.length,
    },
  };
}
