/**
 * Eligibility types shared by the policy engine, the prover, the API and the
 * browser view.
 *
 * The issuer decides who belongs to an eligible class; the dealing policy decides
 * whether a movement may execute; the sponsor decides separately whether to pay
 * for gas. These three decisions are modelled independently.
 */

export type EligibilityClass = "VERIFIED" | "BASIC" | "FLAGGED";

export type ClassCode = 1 | 2 | 3;

export type GateId =
  | "SPOT_ROUTER"
  | "FUND_SUBSCRIPTION"
  | "FUND_REDEMPTION"
  | "SHARE_TRANSFER";

export type DealingRoute =
  | "SPOT_BUY"
  | "SPOT_SELL"
  | "FUND_SUBSCRIPTION"
  | "FUND_REDEMPTION"
  | "SHARE_TRANSFER";

export type DecisionCode =
  | "ALLOW"
  | "ELIGIBILITY_REQUIRED"
  | "SCREENING_DECLINED"
  | "SCREENING_STALE"
  | "SCREENING_REVIEW"
  | "ELIGIBILITY_UNAVAILABLE"
  | "POLICY_CHANGED";

export type MovementDecision = "ALLOW" | "HOLD" | "DECLINE";

export interface PersonaLeaf {
  readonly leafIndex: number;
  readonly personaId: string;
  readonly label: string;
  readonly accountId: string;
  readonly wallet: string;
  readonly class: EligibilityClass;
  readonly epoch: number;
  readonly expiry: number;
  readonly demo: boolean;
}

export interface PersonasFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly chainId: number;
  readonly classCodes: Readonly<Record<EligibilityClass, ClassCode>>;
  readonly leaves: readonly PersonaLeaf[];
}

export interface RootEpochLeaf {
  readonly leafIndex: number;
  readonly personaId: string;
  readonly wallet: string;
  readonly class: EligibilityClass;
  readonly classCode: ClassCode;
  readonly epoch: number;
  readonly expiry: number;
  readonly leafHash: string;
}

export interface RootEpoch {
  readonly epoch: number;
  readonly publishedAt: string;
  readonly leaves: readonly RootEpochLeaf[];
  readonly levels: readonly (readonly string[])[];
  readonly root: string;
}

export interface RootEpochsFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly treeDepth: number;
  readonly chainId: number;
  readonly classCodes: Readonly<Record<EligibilityClass, ClassCode>>;
  readonly epochs: readonly RootEpoch[];
}

export interface PersonaWitness {
  readonly personaId: string;
  readonly wallet: string;
  readonly class: EligibilityClass;
  readonly classCode: ClassCode;
  readonly expiry: number;
  readonly salt: string;
  readonly path: readonly string[];
  readonly indices: readonly boolean[];
}

export interface WitnessesFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly epochs: ReadonlyArray<{
    readonly epoch: number;
    readonly publishedAt: string;
    readonly personas: readonly PersonaWitness[];
  }>;
}

export interface GateFixture {
  readonly gateId: GateId;
  readonly address: string;
  readonly label: string;
  readonly requiredClass: EligibilityClass;
}

export interface GatesFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly gates: readonly GateFixture[];
}

export interface ScreeningRecord {
  readonly partyId: string;
  readonly role: "investor" | "counterparty";
  readonly disposition: "CLEAR" | "REVIEW" | "MATCH";
  readonly refreshedAt: string;
  readonly sourceVersion: string;
}

export interface ScreeningFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly sourceVersion: string;
  readonly maxAgeSeconds: number;
  readonly parties: readonly ScreeningRecord[];
  readonly specialCases: Readonly<Record<string, ScreeningRecord & { readonly note: string }>>;
}

export interface EligibilityPublicInputs {
  readonly wallet: string;
  readonly root: string;
  readonly chainId: string;
  readonly gate: string;
  readonly classCode: string;
  readonly epoch: string;
  readonly expiry: string;
}

export interface EligibilityProof {
  readonly proofHex: string;
  readonly proofDigest: string;
  readonly publicInputs: EligibilityPublicInputs;
  readonly provingMs: number;
  readonly proofSizeBytes: number;
  readonly circuitVersion: string;
  readonly vkHash: string;
}

export interface EligibilityReceipt {
  readonly receiptId: string;
  readonly personaId: string;
  readonly gateId: GateId;
  readonly chainId: number;
  readonly class: EligibilityClass;
  readonly epoch: number;
  readonly expiry: number;
  readonly wallet: string;
  readonly root: string;
  readonly proofDigest: string;
  readonly proofHex: string;
  readonly publicInputs: EligibilityPublicInputs;
  readonly circuitVersion: string;
  readonly vkHash: string;
  readonly provingMs: number;
  readonly verifiedAt: string;
  readonly source: "browser" | "service" | "cli";
}

export interface ReceiptVerification {
  readonly valid: boolean;
  readonly reasons: readonly string[];
  readonly verifyMs: number;
}

export interface PolicyDecision {
  readonly route: DealingRoute;
  readonly gateId: GateId;
  readonly personaId: string;
  readonly decision: MovementDecision;
  readonly code: DecisionCode;
  readonly detail: string;
  readonly requiresProof: boolean;
  readonly receiptValid: boolean | null;
}

export interface SponsorshipDecision {
  readonly personaId: string;
  readonly sponsorship: "APPROVED" | "DECLINED";
  readonly code: "SPONSOR_APPROVED" | "SPONSOR_LIMIT";
  readonly dailyBudgetUsed: string;
  readonly dailyBudget: string;
  readonly holdingsUntouched: boolean;
  readonly detail: string;
}

export interface RootRotationOutcome {
  readonly scenarioId: string;
  readonly personaId: string;
  readonly requestEpoch: number;
  readonly currentEpoch: number;
  readonly decision: MovementDecision;
  readonly code: DecisionCode;
  readonly cashReservedBase: string;
  readonly cashReleasedBase: string;
  readonly unitsMintedBase: string;
  readonly allowedActions: readonly string[];
  readonly detail: string;
}
