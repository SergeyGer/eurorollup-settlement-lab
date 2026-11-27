/**
 * Eligibility and sponsorship policy engine.
 *
 * Three decisions stay separate: the issuer decides class membership, the dealing
 * policy decides whether a movement may execute, and the sponsor decides whether
 * to pay for gas. The engine is deterministic and has no chain access.
 */
import type {
  DealingRoute,
  DecisionCode,
  EligibilityClass,
  EligibilityReceipt,
  GateFixture,
  GateId,
  MovementDecision,
  PersonaLeaf,
  PolicyDecision,
  RootEpoch,
  RootRotationOutcome,
  ScreeningRecord,
  SponsorshipDecision,
} from "./types.js";

export const ELIGIBILITY_POLICY_VERSION = "ELIG-POLICY-1.0.0";

export const CLASS_RANK: Readonly<Record<EligibilityClass, number>> = {
  FLAGGED: 1,
  BASIC: 2,
  VERIFIED: 3,
};

export const ROUTE_GATE: Readonly<Record<DealingRoute, GateId>> = {
  SPOT_BUY: "SPOT_ROUTER",
  SPOT_SELL: "SPOT_ROUTER",
  FUND_SUBSCRIPTION: "FUND_SUBSCRIPTION",
  FUND_REDEMPTION: "FUND_REDEMPTION",
  SHARE_TRANSFER: "SHARE_TRANSFER",
};

/** Routes that mint or move fund units require a proof against the current root. */
const ROUTES_REQUIRING_PROOF: ReadonlySet<DealingRoute> = new Set<DealingRoute>([
  "FUND_SUBSCRIPTION",
  "SHARE_TRANSFER",
]);

export function classRank(eligibilityClass: EligibilityClass): number {
  return CLASS_RANK[eligibilityClass];
}

export function meetsClass(
  eligibilityClass: EligibilityClass,
  requiredClass: EligibilityClass,
): boolean {
  return classRank(eligibilityClass) >= classRank(requiredClass);
}

export function screeningAgeSeconds(record: ScreeningRecord, clockIso: string): number {
  return Math.floor((Date.parse(clockIso) - Date.parse(record.refreshedAt)) / 1000);
}

export interface RouteEvaluationParams {
  readonly route: DealingRoute;
  readonly persona: PersonaLeaf;
  readonly gate: GateFixture;
  readonly screening: ScreeningRecord | undefined;
  readonly clockIso: string;
  readonly screeningMaxAgeSeconds: number;
  readonly sourceVersion: string;
  readonly currentRoot: RootEpoch;
  /** Result of verifying a cached receipt, or null when no proof is available. */
  readonly receiptValid: boolean | null;
  readonly receipt?: EligibilityReceipt;
}

function decision(params: {
  route: DealingRoute;
  gateId: GateId;
  personaId: string;
  decision: MovementDecision;
  code: DecisionCode;
  detail: string;
  requiresProof: boolean;
  receiptValid: boolean | null;
}): PolicyDecision {
  return params;
}

export function evaluateRoute(params: RouteEvaluationParams): PolicyDecision {
  const gateId = params.gate.gateId;
  const base = {
    route: params.route,
    gateId,
    personaId: params.persona.personaId,
    requiresProof: ROUTES_REQUIRING_PROOF.has(params.route),
    receiptValid: params.receiptValid,
  };
  const { screening } = params;
  if (screening === undefined) {
    return decision({
      ...base,
      decision: "HOLD",
      code: "ELIGIBILITY_UNAVAILABLE",
      detail: "No current screening record is available for this party.",
    });
  }
  if (screening.sourceVersion !== params.sourceVersion) {
    return decision({
      ...base,
      decision: "HOLD",
      code: "SCREENING_STALE",
      detail: `Screening source ${screening.sourceVersion} is not the current source ${params.sourceVersion}.`,
    });
  }
  const age = screeningAgeSeconds(screening, params.clockIso);
  if (age > params.screeningMaxAgeSeconds) {
    return decision({
      ...base,
      decision: "HOLD",
      code: "SCREENING_STALE",
      detail: `Screening refresh is ${age}s old, above the ${params.screeningMaxAgeSeconds}s limit.`,
    });
  }
  if (screening.disposition === "REVIEW") {
    return decision({
      ...base,
      decision: "HOLD",
      code: "SCREENING_REVIEW",
      detail: "Screening returned REVIEW; a reviewer must resolve the case before execution.",
    });
  }
  if (screening.disposition === "MATCH") {
    return decision({
      ...base,
      decision: "DECLINE",
      code: "SCREENING_DECLINED",
      detail: "A synthetic screening match blocks managed spot and fund routes.",
    });
  }
  if (!meetsClass(params.persona.class, params.gate.requiredClass)) {
    return decision({
      ...base,
      decision: "DECLINE",
      code: "ELIGIBILITY_REQUIRED",
      detail: `The ${params.gate.label} requires class ${params.gate.requiredClass}; this persona is ${params.persona.class}.`,
    });
  }
  if (params.clockIso > new Date(params.persona.expiry * 1000).toISOString()) {
    return decision({
      ...base,
      decision: "HOLD",
      code: "ELIGIBILITY_UNAVAILABLE",
      detail: "The eligibility credential has expired; a new issuer epoch is required.",
    });
  }
  if (base.requiresProof) {
    if (params.receiptValid === null) {
      return decision({
        ...base,
        decision: "HOLD",
        code: "ELIGIBILITY_UNAVAILABLE",
        detail: "No eligibility proof is available for this movement.",
      });
    }
    if (!params.receiptValid) {
      return decision({
        ...base,
        decision: "HOLD",
        code: "POLICY_CHANGED",
        detail: "The cached approval is no longer valid against the current issuer root.",
      });
    }
    const receipt = params.receipt;
    if (receipt !== undefined) {
      if (receipt.epoch !== params.currentRoot.epoch) {
        return decision({
          ...base,
          decision: "HOLD",
          code: "POLICY_CHANGED",
          detail: `Approval epoch ${receipt.epoch} is not the current epoch ${params.currentRoot.epoch}.`,
        });
      }
      if (receipt.root !== params.currentRoot.root) {
        return decision({
          ...base,
          decision: "HOLD",
          code: "POLICY_CHANGED",
          detail: "The approval root differs from the current issuer root.",
        });
      }
      if (!meetsClass(receipt.class, params.gate.requiredClass)) {
        return decision({
          ...base,
          decision: "DECLINE",
          code: "ELIGIBILITY_REQUIRED",
          detail: "The proven class does not satisfy this gate.",
        });
      }
    }
  }
  return decision({
    ...base,
    decision: "ALLOW",
    code: "ALLOW",
    detail: `${params.persona.label} satisfies screening, class and proof requirements for ${params.route}.`,
  });
}

export interface RootRotationParams {
  readonly persona: PersonaLeaf;
  readonly requestEpoch: RootEpoch;
  readonly currentRoot: RootEpoch;
  readonly cashReservedBase: string;
  readonly custodyAccount: string;
}

/** A root update between fund request and allocation holds the reserved cash. */
export function evaluateRootRotation(params: RootRotationParams): RootRotationOutcome {
  const stillPresent = params.currentRoot.leaves.some(
    (leaf) => leaf.personaId === params.persona.personaId,
  );
  if (stillPresent && params.currentRoot.epoch === params.requestEpoch.epoch) {
    return {
      scenarioId: "ROOT-ROTATION-HOLD",
      personaId: params.persona.personaId,
      requestEpoch: params.requestEpoch.epoch,
      currentEpoch: params.currentRoot.epoch,
      decision: "ALLOW",
      code: "ALLOW",
      cashReservedBase: params.cashReservedBase,
      cashReleasedBase: "0",
      unitsMintedBase: "0",
      allowedActions: ["allocate_after_nav"],
      detail: "The issuer root did not change; the pending allocation can continue.",
    };
  }
  return {
    scenarioId: "ROOT-ROTATION-HOLD",
    personaId: params.persona.personaId,
    requestEpoch: params.requestEpoch.epoch,
    currentEpoch: params.currentRoot.epoch,
    decision: "HOLD",
    code: "POLICY_CHANGED",
    cashReservedBase: params.cashReservedBase,
    cashReleasedBase: "0",
    unitsMintedBase: "0",
    allowedActions: ["authorized_refund", "revalidate_with_current_proof"],
    detail: `Epoch ${params.currentRoot.epoch} no longer contains this persona; reserved cash stays in custody and no units are minted.`,
  };
}

export interface SponsorshipParams {
  readonly persona: PersonaLeaf;
  readonly dailyBudgetUsedBase: string;
  readonly dailyBudgetBase: string;
  readonly nativeDepositBase: string;
  readonly nativeCostCeilingBase: string;
}

/** Sponsorship is declined independently; business holdings are untouched. */
export function decideSponsorship(params: SponsorshipParams): SponsorshipDecision {
  const used = BigInt(params.dailyBudgetUsedBase);
  const budget = BigInt(params.dailyBudgetBase);
  const deposit = BigInt(params.nativeDepositBase);
  const ceiling = BigInt(params.nativeCostCeilingBase);
  if (used + ceiling > budget) {
    return {
      personaId: params.persona.personaId,
      sponsorship: "DECLINED",
      code: "SPONSOR_LIMIT",
      dailyBudgetUsed: used.toString(),
      dailyBudget: budget.toString(),
      holdingsUntouched: true,
      detail: "The per-operation ceiling would exceed the remaining daily sponsorship budget.",
    };
  }
  if (deposit < ceiling) {
    return {
      personaId: params.persona.personaId,
      sponsorship: "DECLINED",
      code: "SPONSOR_LIMIT",
      dailyBudgetUsed: used.toString(),
      dailyBudget: budget.toString(),
      holdingsUntouched: true,
      detail: "The sponsor's native deposit is below the per-operation ceiling.",
    };
  }
  return {
    personaId: params.persona.personaId,
    sponsorship: "APPROVED",
    code: "SPONSOR_APPROVED",
    dailyBudgetUsed: used.toString(),
    dailyBudget: budget.toString(),
    holdingsUntouched: true,
    detail: "The permit is within the daily budget and the sponsor deposit covers the ceiling.",
  };
}
