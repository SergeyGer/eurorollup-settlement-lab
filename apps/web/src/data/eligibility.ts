/**
 * Browser-side eligibility data.
 *
 * The policy matrix, root rotation and sponsorship cards are computed locally
 * from the bundled fixtures with the shared policy engine, so the view stays
 * deterministic and works offline. The account-abstraction receipts are the
 * committed A04 evidence recorded against the pinned local chain.
 */
import {
  ROUTE_GATE,
  decideSponsorship,
  evaluateRootRotation,
  evaluateRoute,
  epochByNumber,
  gatesFixture,
  personaById,
  personasFixture,
  rootsFixture,
  screeningByParty,
  screeningFixture,
  type DealingRoute,
  type MovementDecision,
  type PolicyDecision,
} from "@eurorollup/eligibility";
import aaEvidenceJson from "../../../../evidence/a04/aa-receipts.json";

export const MATRIX_CLOCK_ISO = "2026-11-20T15:30:00Z";

export const MATRIX_ROUTES: readonly DealingRoute[] = [
  "SPOT_BUY",
  "SPOT_SELL",
  "FUND_SUBSCRIPTION",
  "FUND_REDEMPTION",
  "SHARE_TRANSFER",
];

export interface MatrixRow {
  readonly personaId: string;
  readonly class: string;
  readonly route: DealingRoute;
  readonly decision: MovementDecision;
  readonly code: string;
  readonly requiresProof: boolean;
  readonly receiptValid: boolean | null;
  readonly detail: string;
  readonly scenario: string;
}

function gateFor(route: DealingRoute) {
  return gatesFixture.gates.find((gate) => gate.gateId === ROUTE_GATE[route]);
}

function decide(params: {
  personaId: string;
  route: DealingRoute;
  epoch: number;
  receiptValid?: boolean | null;
  screening?: ReturnType<typeof screeningByParty>;
  clockIso?: string;
}): PolicyDecision {
  const persona = personaById(params.personaId);
  const gate = gateFor(params.route);
  const epoch = epochByNumber(params.epoch);
  if (persona === undefined || gate === undefined || epoch === undefined) {
    throw new Error(`missing fixture for ${params.personaId}/${params.route}`);
  }
  const screening =
    params.screening ?? screeningByParty(persona.accountId) ?? screeningByParty("investor-ada");
  if (screening === undefined) {
    throw new Error("missing screening fixture");
  }
  return evaluateRoute({
    route: params.route,
    persona,
    gate,
    screening,
    clockIso: params.clockIso ?? MATRIX_CLOCK_ISO,
    screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
    sourceVersion: screeningFixture.sourceVersion,
    currentRoot: epoch,
    receiptValid: params.receiptValid === undefined ? true : params.receiptValid,
  });
}

export function buildMatrixRows(): readonly MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const personaId of ["persona-verified", "persona-basic", "persona-flagged"]) {
    const persona = personaById(personaId);
    if (persona === undefined) continue;
    for (const route of MATRIX_ROUTES) {
      const decision = decide({ personaId, route, epoch: 1 });
      rows.push({
        personaId,
        class: persona.class,
        route,
        decision: decision.decision,
        code: decision.code,
        requiresProof: decision.requiresProof,
        receiptValid: decision.receiptValid,
        detail: decision.detail,
        scenario: "current-root",
      });
    }
  }
  const stale = screeningFixture.specialCases["stale"];
  const ambiguous = screeningFixture.specialCases["ambiguous"];
  const freshAfterExpiry = screeningFixture.specialCases["freshAfterExpiry"];
  const specials: Array<{
    scenario: string;
    personaId: string;
    route: DealingRoute;
    screening?: ReturnType<typeof screeningByParty>;
    clockIso?: string;
    receiptValid?: boolean | null;
  }> = [
    { scenario: "stale-screening", personaId: "persona-verified", route: "FUND_SUBSCRIPTION", screening: stale },
    { scenario: "review-disposition", personaId: "persona-verified", route: "SPOT_BUY", screening: ambiguous },
    { scenario: "missing-proof", personaId: "persona-verified", route: "FUND_SUBSCRIPTION", receiptValid: null },
    {
      scenario: "expired-credential",
      personaId: "persona-verified",
      route: "FUND_SUBSCRIPTION",
      screening: freshAfterExpiry,
      clockIso: "2026-12-02T00:00:00Z",
    },
  ];
  for (const special of specials) {
    const persona = personaById(special.personaId);
    if (persona === undefined) continue;
    const decision = decide({
      personaId: special.personaId,
      route: special.route,
      epoch: 1,
      ...(special.screening === undefined ? {} : { screening: special.screening }),
      ...(special.clockIso === undefined ? {} : { clockIso: special.clockIso }),
      ...(special.receiptValid === undefined ? {} : { receiptValid: special.receiptValid }),
    });
    rows.push({
      personaId: special.personaId,
      class: persona.class,
      route: special.route,
      decision: decision.decision,
      code: decision.code,
      requiresProof: decision.requiresProof,
      receiptValid: decision.receiptValid,
      detail: decision.detail,
      scenario: special.scenario,
    });
  }
  return rows;
}

export function rotation(): ReturnType<typeof evaluateRootRotation> {
  const persona = personaById("persona-verified");
  const requestEpoch = epochByNumber(1);
  const currentRoot = epochByNumber(2);
  if (persona === undefined || requestEpoch === undefined || currentRoot === undefined) {
    throw new Error("missing rotation fixtures");
  }
  return evaluateRootRotation({
    persona,
    requestEpoch,
    currentRoot,
    cashReservedBase: "300000000",
    custodyAccount: "fund-escrow",
  });
}

export function sponsorship(): ReturnType<typeof decideSponsorship> {
  const persona = personaById("persona-basic");
  if (persona === undefined) {
    throw new Error("missing basic persona");
  }
  return decideSponsorship({
    persona,
    dailyBudgetUsedBase: "99000000000000000",
    dailyBudgetBase: "100000000000000000",
    nativeDepositBase: "50000000000000000",
    nativeCostCeilingBase: "3000000000000000",
  });
}

export interface AaCase {
  readonly caseId: string;
  readonly kind: string;
  readonly outerTxHash: string;
  readonly outerTxStatus: number;
  readonly userOperationEvent: { readonly success: boolean; readonly actualGasCost: string } | null;
  readonly userChargeBase: string;
  readonly paymasterDepositDeltaBase: string;
  readonly revertReason: string | null;
}

export const aaEvidence = aaEvidenceJson as unknown as {
  readonly chain: { readonly chainId: number };
  readonly contracts: Readonly<Record<string, string>>;
  readonly cases: readonly AaCase[];
  readonly summary: { readonly cases: number; readonly passed: number; readonly passedAll: boolean };
};

export function policyMeta() {
  const current = rootsFixture.epochs[rootsFixture.epochs.length - 1]!;
  return {
    personas: personasFixture.leaves.filter((leaf) => leaf.demo),
    epochs: rootsFixture.epochs.map((epoch) => ({
      epoch: epoch.epoch,
      publishedAt: epoch.publishedAt,
      root: epoch.root,
      leafCount: epoch.leaves.length,
    })),
    gates: gatesFixture.gates,
    currentEpoch: current.epoch,
  };
}

export function shortHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-6)}`;
}
