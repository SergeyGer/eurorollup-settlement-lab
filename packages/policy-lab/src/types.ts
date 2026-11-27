/**
 * Policy Lab contract types.
 *
 * The model-facing proposal schema is deliberately small: one constrained
 * operation, documented enums and a text limit. Numerical outcomes are never
 * part of a proposal — they are computed by the deterministic replay after the
 * user confirms the typed change.
 */
import type { FundDealingPolicy, PolicyWeekday } from "@eurorollup/dealing";

export type ProposalStatus = "proposed" | "clarify" | "unsupported";

export type PolicyOperation = "set_subscription_cutoff";

export interface ProposedProposal {
  readonly status: "proposed";
  readonly operation: PolicyOperation;
  readonly asset: "eFUND";
  readonly weekday: PolicyWeekday;
  readonly timeUtc: string;
  readonly timezone: "UTC";
  /** A prior time stated by the user; rejected when it disagrees with the baseline. */
  readonly expectedTimeUtc?: string;
}

export interface ClarifyProposal {
  readonly status: "clarify";
  readonly question: string;
  readonly missingFields: readonly string[];
}

export type UnsupportedReasonCode =
  | "UNSUPPORTED_OPERATION"
  | "UNSUPPORTED_ASSET"
  | "UNSUPPORTED_WEEKDAY"
  | "OUT_OF_RANGE"
  | "MULTIPLE_CHANGES";

export interface UnsupportedProposal {
  readonly status: "unsupported";
  readonly reasonCode: UnsupportedReasonCode;
}

export type Proposal = ProposedProposal | ClarifyProposal | UnsupportedProposal;

export type DraftOrigin = "recorded" | "live" | "manual";

export type DraftMode = "recorded" | "live" | "manual";

export type DraftStatus = "proposed" | "clarify" | "unsupported" | "no_change";

export interface ProposalDiff {
  readonly asset: "eFUND";
  readonly orderType: "FUND_SUBSCRIPTION";
  readonly weekday: PolicyWeekday;
  readonly oldTimeUtc: string;
  readonly newTimeUtc: string;
  readonly timezone: "UTC";
}

export interface PolicyBaselineRef {
  readonly policyId: string;
  readonly version: number;
  readonly policyHash: string;
  readonly weekdayCutoffs: Readonly<Record<PolicyWeekday, string>>;
}

export interface ScenarioFixtureRef {
  readonly fixtureId: "P01";
  readonly fixtureVersion: string;
  readonly fixtureHash: string;
  readonly calendarId: string;
  readonly calendarVersion: string;
  readonly calendarHash: string;
}

export interface ReplayDraft {
  readonly scenarioId: string | null;
  readonly revision: number;
  readonly origin: DraftOrigin;
  readonly status: DraftStatus;
  readonly label: string;
  readonly question: string | null;
  readonly proposal: Proposal | null;
  readonly diff: ProposalDiff | null;
  readonly clarify: { readonly question: string; readonly missingFields: readonly string[] } | null;
  readonly unsupportedReasonCode: string | null;
  readonly baseline: PolicyBaselineRef;
  readonly fixture: ScenarioFixtureRef;
  readonly draftDigest: string;
  readonly confirmationDigest: string;
  readonly parentRevision: number | null;
  readonly parentDraftDigest: string | null;
  readonly createdAt: string;
}

export interface ManualFields {
  readonly weekday?: string;
  readonly timeUtc?: string;
  readonly timezone?: string;
  readonly expectedTimeUtc?: string;
}

export interface ScenarioDraftInput {
  readonly fixtureId: string;
  readonly mode: DraftMode;
  readonly question?: string;
  readonly manualFields?: ManualFields;
}

export interface RecordedProposalFixture {
  readonly proposalId: string;
  readonly fixtureVersion: string;
  readonly label: string;
  readonly question: string;
  readonly proposal: Proposal;
  /** Metadata from the live adapter that captured the recorded proposal. */
  readonly capture?: {
    readonly provider: string;
    readonly model: string;
    readonly digest: string | null;
    readonly promptVersion: string;
    readonly temperature: number;
    readonly seed: number;
    readonly attempts: number;
    readonly elapsedMs: number;
    readonly rawOutput: string;
    readonly capturedBy: string;
  };
}

export interface BranchOrderResult {
  readonly orderId: string;
  readonly investorId: string;
  readonly requestedAt: string;
  readonly dealingDate: string;
  readonly dealingReason: string;
  readonly unitsBase: string | null;
  readonly navBase: string | null;
  readonly pending: boolean;
  readonly reservedAtFridayCloseBase: string;
}

export interface BranchSnapshot {
  readonly spendableBase: string;
  readonly reservedBase: string;
  readonly unitsBase: string;
}

export interface BranchResult {
  readonly branchId: "baseline" | "candidate";
  readonly policy: FundDealingPolicy;
  readonly policyHash: string;
  readonly eventLogHash: string;
  readonly orders: readonly BranchOrderResult[];
  readonly snapshots: Readonly<Record<string, BranchSnapshot>>;
}

export interface OrderChange {
  readonly orderId: string;
  readonly requestedAt: string;
  readonly baselineDealingDate: string;
  readonly candidateDealingDate: string;
  readonly baselineUnitsBase: string | null;
  readonly candidateUnitsBase: string | null;
  readonly unitsDeltaBase: string | null;
  readonly reservedAtFridayCloseBase: string;
  readonly changesDealingDate: boolean;
  readonly reason: string;
}

export interface P01Comparison {
  readonly schemaVersion: string;
  readonly fixtureId: "P01";
  readonly fixtureVersion: string;
  readonly engineVersion: string;
  readonly policyLabVersion: string;
  readonly fixtureHash: string;
  readonly calendarHash: string;
  readonly baseline: BranchResult;
  readonly candidate: BranchResult;
  readonly orderChanges: readonly OrderChange[];
  readonly affectedOrders: number;
  readonly totalOrders: number;
  readonly extraReservedAtFridayCloseBase: string;
  readonly deltas: {
    readonly changedOrderIds: readonly string[];
    readonly unitDeltaByOrder: Readonly<Record<string, string | null>>;
    readonly extraReservedAtFridayCloseBase: string;
  };
  readonly comparisonDigest: string;
}

export interface P01BoundaryCaseFixture {
  readonly caseId: string;
  readonly description: string;
  readonly requestedAt: string;
  readonly calendarId: string;
  readonly publishNavDates: readonly string[];
  readonly expected: {
    readonly baselineDealingDate: string;
    readonly candidateDealingDate: string;
    readonly baselineUnitsBase?: string;
    readonly candidateUnitsBase?: string;
    readonly candidatePending?: boolean;
    readonly candidateReservedCashBase?: string;
  };
}

export interface P01BoundaryFixture {
  readonly fixtureId: "P01-boundaries";
  readonly fixtureVersion: string;
  readonly description: string;
  readonly cases: readonly P01BoundaryCaseFixture[];
}

export interface BoundaryCaseResult {
  readonly caseId: string;
  readonly description: string;
  readonly requestedAt: string;
  readonly calendarId: string;
  readonly baseline: {
    readonly dealingDate: string;
    readonly unitsBase: string | null;
    readonly pending: boolean;
  };
  readonly candidate: {
    readonly dealingDate: string;
    readonly unitsBase: string | null;
    readonly pending: boolean;
    readonly reservedCashBase: string;
  };
  readonly expected: P01BoundaryCaseFixture["expected"];
  readonly pass: boolean;
}
