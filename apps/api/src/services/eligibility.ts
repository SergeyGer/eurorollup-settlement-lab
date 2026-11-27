/**
 * Eligibility, sponsorship and account-abstraction service.
 *
 * Exposes the three separate decisions (issuer class, dealing gate, sponsor) to
 * the API and generates real Noir membership proofs on request. The service is
 * read-only for settlement state; a fund order still executes through the normal
 * order and outbox path.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashJson } from "@eurorollup/dealing";
import {
  ELIGIBILITY_POLICY_VERSION,
  ROUTE_GATE,
  circuitMetadata,
  decideSponsorship,
  epochByNumber,
  gatesFixture,
  personaById,
  personaByAccountId,
  evaluateRoute,
  personasFixture,
  proveEligibility,
  rootsFixture,
  screeningByParty,
  screeningFixture,
  verifyEligibilityProof,
  witnessFor,
  type EligibilityClass,
  type EligibilityReceipt,
  type GateId,
  type PersonaLeaf,
} from "@eurorollup/eligibility";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db.js";
import { getAccount, readClock } from "../db.js";
import { problem } from "../problems.js";
import type { ClockService } from "../clock-service.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const aaEvidencePath = join(repoRoot, "evidence/a04/aa-receipts.json");

export interface EligibilityPersonaView {
  readonly personaId: string;
  readonly label: string;
  readonly accountId: string;
  readonly class: EligibilityClass;
  readonly epoch: number;
  readonly expiry: string;
}

export interface RouteDecisionView {
  readonly personaId: string;
  readonly route: string;
  readonly gateId: string;
  readonly decision: string;
  readonly code: string;
  readonly detail: string;
  readonly requiresProof: boolean;
  readonly receiptValid: boolean | null;
}

export interface EligibilityPolicyView {
  readonly policyVersion: string;
  readonly personas: readonly EligibilityPersonaView[];
  readonly epochs: readonly {
    readonly epoch: number;
    readonly publishedAt: string;
    readonly root: string;
    readonly leafCount: number;
  }[];
  readonly gates: readonly {
    readonly gateId: string;
    readonly address: string;
    readonly requiredClass: string;
    readonly label: string;
  }[];
  readonly screening: {
    readonly sourceVersion: string;
    readonly maxAgeSeconds: number;
  };
  readonly circuit: {
    readonly circuitVersion: string;
    readonly proofSystem: string;
    readonly vkHash: string;
    readonly circuitSha256: string;
    readonly publicInputs: readonly string[];
    readonly treeDepth: number;
  };
  readonly currentEpoch: number;
}

export interface EligibilityAccountView {
  readonly accountId: string;
  readonly personaId: string;
  readonly class: EligibilityClass;
  readonly epoch: number;
  readonly currentEpoch: number;
  readonly decisions: readonly RouteDecisionView[];
  readonly rotation: {
    readonly requestEpoch: number;
    readonly currentEpoch: number;
    readonly decision: string;
    readonly code: string;
    readonly detail: string;
  } | null;
}

export interface ProofRequestInput {
  readonly personaId: string;
  readonly epoch: number;
  readonly gateId: GateId;
}

export interface ProofResponse {
  readonly receipt: EligibilityReceipt;
  readonly verified: boolean;
  readonly verifyMs: number;
}

export interface AccountAbstractionSummary {
  readonly chainId: number;
  readonly contracts: Record<string, string>;
  readonly cases: readonly {
    readonly caseId: string;
    readonly kind: string;
    readonly outerTxHash: string;
    readonly outerTxStatus: number;
    readonly userOperationEventPresent: boolean;
    readonly userOperationSuccess: boolean | null;
    readonly userChargeBase: string;
    readonly paymasterDepositDeltaBase: string;
    readonly actualGasCost: string | null;
    readonly pass: boolean;
  }[];
  readonly summary: { readonly cases: number; readonly passed: number; readonly passedAll: boolean };
}

function toPersonaView(persona: PersonaLeaf, epoch: number): EligibilityPersonaView {
  return {
    personaId: persona.personaId,
    label: persona.label,
    accountId: persona.accountId,
    class: persona.class,
    epoch,
    expiry: new Date(persona.expiry * 1000).toISOString(),
  };
}

export class EligibilityService {
  private readonly db: Database;
  private readonly config: ApiConfig;
  private readonly clock: ClockService;

  constructor(db: Database, config: ApiConfig, clock: ClockService) {
    this.db = db;
    this.config = config;
    this.clock = clock;
  }

  policy(): EligibilityPolicyView {
    const current = rootsFixture.epochs[rootsFixture.epochs.length - 1]!;
    const demoPersonas = personasFixture.leaves.filter((leaf) => leaf.demo);
    return {
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      personas: demoPersonas.map((persona) => toPersonaView(persona, persona.epoch)),
      epochs: rootsFixture.epochs.map((epoch) => ({
        epoch: epoch.epoch,
        publishedAt: epoch.publishedAt,
        root: epoch.root,
        leafCount: epoch.leaves.length,
      })),
      gates: gatesFixture.gates.map((gate) => ({
        gateId: gate.gateId,
        address: gate.address,
        requiredClass: gate.requiredClass,
        label: gate.label,
      })),
      screening: {
        sourceVersion: screeningFixture.sourceVersion,
        maxAgeSeconds: screeningFixture.maxAgeSeconds,
      },
      circuit: {
        circuitVersion: circuitMetadata.circuitVersion,
        proofSystem: circuitMetadata.proofSystem,
        vkHash: circuitMetadata.vkHash,
        circuitSha256: circuitMetadata.circuitSha256,
        publicInputs: circuitMetadata.publicInputs,
        treeDepth: circuitMetadata.treeDepth,
      },
      currentEpoch: current.epoch,
    };
  }

  accountDecision(accountId: string, epochNumber?: number): EligibilityAccountView {
    const account = getAccount(this.db, accountId);
    if (account === null) {
      throw problem(404, "ACCOUNT_NOT_FOUND", `Unknown account ${accountId}`);
    }
    const persona = this.resolvePersona(accountId, account.persona);
    const epoch = epochByNumber(epochNumber ?? rootsFixture.epochs.length) ?? rootsFixture.epochs[0]!;
    const current = rootsFixture.epochs[rootsFixture.epochs.length - 1]!;
    const receiptValid = witnessFor(epoch.epoch, persona.personaId) !== undefined;
    const clockIso = readClock(this.db);
    const decisions = this.decisionsFor({ persona, epoch, clockIso, receiptValid });
    const present = current.leaves.some((leaf) => leaf.personaId === persona.personaId);
    const rotation =
      epoch.epoch !== current.epoch
        ? {
            requestEpoch: epoch.epoch,
            currentEpoch: current.epoch,
            decision: present ? "ALLOW" : "HOLD",
            code: present ? "ALLOW" : "POLICY_CHANGED",
            detail: present
              ? "The issuer root still contains this persona."
              : "The current root no longer contains this persona; reserved cash stays in custody and no units are minted.",
          }
        : null;
    return {
      accountId,
      personaId: persona.personaId,
      class: persona.class,
      epoch: epoch.epoch,
      currentEpoch: current.epoch,
      decisions,
      rotation,
    };
  }

  async createProof(input: ProofRequestInput, source: "browser" | "service" | "cli" = "service"): Promise<ProofResponse> {
    if (typeof input.personaId !== "string" || typeof input.epoch !== "number") {
      throw problem(400, "INVALID_REQUEST", "personaId and epoch are required");
    }
    const gate = gatesFixture.gates.find((item) => item.gateId === input.gateId);
    if (gate === undefined) {
      throw problem(400, "INVALID_REQUEST", `Unsupported gate ${String(input.gateId)}`);
    }
    let proof;
    try {
      proof = await proveEligibility({
        personaId: input.personaId,
        epoch: input.epoch,
        gateId: input.gateId,
      });
    } catch (error) {
      throw problem(422, "PROOF_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
    const verification = await verifyEligibilityProof({
      proofHex: proof.proofHex,
      publicInputs: proof.publicInputs,
    });
    if (!verification.valid) {
      throw problem(500, "PROOF_INVALID", "The generated proof did not verify");
    }
    const persona = personaById(input.personaId);
    const epoch = epochByNumber(input.epoch);
    if (persona === undefined || epoch === undefined) {
      throw problem(422, "PROOF_UNAVAILABLE", "Unknown persona or epoch");
    }
    const receipt: EligibilityReceipt = {
      receiptId: `rcpt_${hashJson({
        personaId: persona.personaId,
        epoch: input.epoch,
        gateId: input.gateId,
        digest: proof.proofDigest,
      }).slice(0, 20)}`,
      personaId: persona.personaId,
      gateId: input.gateId,
      chainId: personasFixture.chainId,
      class: epoch.leaves.find((leaf) => leaf.personaId === persona.personaId)?.class ?? persona.class,
      epoch: epoch.epoch,
      expiry: epoch.leaves.find((leaf) => leaf.personaId === persona.personaId)?.expiry ?? persona.expiry,
      wallet: proof.publicInputs.wallet,
      root: proof.publicInputs.root,
      proofDigest: proof.proofDigest,
      proofHex: proof.proofHex,
      publicInputs: proof.publicInputs,
      circuitVersion: proof.circuitVersion,
      vkHash: proof.vkHash,
      provingMs: proof.provingMs,
      verifiedAt: readClock(this.db),
      source,
    };
    return { receipt, verified: true, verifyMs: verification.verifyMs };
  }

  async verifyProof(input: {
    proofHex: string;
    publicInputs: EligibilityReceipt["publicInputs"];
  }): Promise<{ valid: boolean; verifyMs: number; reasons: readonly string[] }> {
    if (typeof input.proofHex !== "string" || !/^[0-9a-f]+$/i.test(input.proofHex) || input.proofHex.length > 100_000) {
      throw problem(400, "INVALID_REQUEST", "proofHex must be a bounded hex string");
    }
    return verifyEligibilityProof({ proofHex: input.proofHex, publicInputs: input.publicInputs });
  }

  sponsorship() {
    const persona = this.resolvePersona("investor-cy", "basic");
    const decision = decideSponsorship({
      persona,
      dailyBudgetUsedBase: "99000000000000000",
      dailyBudgetBase: "100000000000000000",
      nativeDepositBase: "50000000000000000",
      nativeCostCeilingBase: "3000000000000000",
    });
    return {
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      sponsor: {
        dailyBudgetBase: decision.dailyBudget,
        dailyBudgetUsedBase: decision.dailyBudgetUsed,
        perOperationCeilingBase: "3000000000000000",
        nativeDepositBase: "50000000000000000",
      },
      decision,
    };
  }

  accountAbstraction(): AccountAbstractionSummary {
    const evidence = JSON.parse(readFileSync(aaEvidencePath, "utf8")) as {
      chain: { chainId: number };
      contracts: Record<string, string>;
      cases: Array<{
        caseId: string;
        kind: string;
        outerTxHash: string;
        outerTxStatus: number;
        userOperationEvent: { success: boolean; actualGasCost: string } | null;
        userChargeBase: string;
        paymasterDepositDeltaBase: string;
        pass: boolean;
      }>;
      summary: { cases: number; passed: number; passedAll: boolean };
    };
    return {
      chainId: evidence.chain.chainId,
      contracts: evidence.contracts,
      cases: evidence.cases.map((item) => ({
        caseId: item.caseId,
        kind: item.kind,
        outerTxHash: item.outerTxHash,
        outerTxStatus: item.outerTxStatus,
        userOperationEventPresent: item.userOperationEvent !== null,
        userOperationSuccess: item.userOperationEvent?.success ?? null,
        userChargeBase: item.userChargeBase,
        paymasterDepositDeltaBase: item.paymasterDepositDeltaBase,
        actualGasCost: item.userOperationEvent?.actualGasCost ?? null,
        pass: item.pass,
      })),
      summary: evidence.summary,
    };
  }

  /** Managed orders require clear screening and the documented class for the gate. */
  assertManagedRouteAllowed(accountId: string, route: keyof typeof ROUTE_GATE, nowIso: string): void {
    const account = getAccount(this.db, accountId);
    if (account === null) {
      return;
    }
    const persona = this.resolvePersona(accountId, account.persona);
    const epoch = epochByNumber(1);
    if (epoch === undefined) {
      return;
    }
    const decision = this.decisionsFor({
      persona,
      epoch,
      clockIso: nowIso,
      receiptValid: true,
      route,
    })[0];
    if (decision === undefined || decision.decision === "ALLOW") {
      return;
    }
    const status = decision.decision === "DECLINE" ? 422 : 409;
    throw problem(status, decision.code, decision.detail, {
      route: decision.route,
      gateId: decision.gateId,
      personaId: decision.personaId,
    });
  }

  private resolvePersona(accountId: string, personaName: string | undefined): PersonaLeaf {
    const byAccount = personaByAccountId(accountId);
    if (byAccount !== undefined) {
      return byAccount;
    }
    const normalized = (personaName ?? "verified").toLowerCase();
    const candidateId =
      normalized === "basic" ? "persona-basic" : normalized === "flagged" ? "persona-flagged" : "persona-verified";
    const persona = personaById(candidateId);
    if (persona === undefined) {
      throw problem(500, "ELIGIBILITY_FIXTURE_MISSING", "Eligibility persona fixtures are incomplete");
    }
    return persona;
  }

  private decisionsFor(params: {
    persona: PersonaLeaf;
    epoch: { epoch: number };
    clockIso: string;
    receiptValid: boolean;
    route?: keyof typeof ROUTE_GATE;
  }): RouteDecisionView[] {
    const routes = (params.route === undefined
      ? ["SPOT_BUY", "SPOT_SELL", "FUND_SUBSCRIPTION", "FUND_REDEMPTION", "SHARE_TRANSFER"]
      : [params.route]) as Array<keyof typeof ROUTE_GATE>;
    const epoch = epochByNumber(params.epoch.epoch);
    if (epoch === undefined) {
      return [];
    }
    const screening = screeningByParty(params.persona.accountId) ?? screeningByParty("investor-ada");
    return routes.map((route) => {
      const gateId = ROUTE_GATE[route];
      const gate = gatesFixture.gates.find((item) => item.gateId === gateId);
      if (gate === undefined) {
        throw problem(500, "ELIGIBILITY_FIXTURE_MISSING", `Missing gate ${gateId}`);
      }
      const decision = evaluateRoute({
        route,
        persona: params.persona,
        gate,
        screening,
        clockIso: params.clockIso,
        screeningMaxAgeSeconds: screeningFixture.maxAgeSeconds,
        sourceVersion: screeningFixture.sourceVersion,
        currentRoot: epoch,
        receiptValid: params.receiptValid,
      });
      return {
        personaId: params.persona.personaId,
        route: String(route),
        gateId,
        decision: decision.decision,
        code: decision.code,
        detail: decision.detail,
        requiresProof: decision.requiresProof,
        receiptValid: decision.receiptValid,
      };
    });
  }
}
