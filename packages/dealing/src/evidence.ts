/**
 * Evidence pack construction for released gates.
 *
 * A pack is reproducible: the same frozen inputs always produce the same bytes,
 * the same per-case digests and the same pack digest. Model prose, execution
 * timestamps and random run ids are never part of a digest.
 */
import type { DealingCalendar } from "./calendar.js";
import type { PortfolioSnapshot } from "./engine.js";
import { canonicalJson, hashJson, sha256Hex } from "./hash.js";
import type { Receipt } from "./receipts.js";
import type { BoundaryCaseResult } from "./scenarios.js";
import type {
  BoundaryCasesFixture,
  CalendarFixture,
  G01RedemptionScenario,
  G01Scenario,
} from "./scenario-types.js";
import { EVIDENCE_SCHEMA_VERSION, ENGINE_VERSION, GOLDEN_RUN_SCHEMA_VERSION } from "./version.js";
import type { AppliedStep } from "./engine.js";

export interface SerializablePosting {
  readonly account: { readonly kind: string; readonly accountId: string };
  readonly assetId: string;
  readonly amountBase: string;
}

export interface GoldenCase {
  readonly caseId: string;
  readonly title: string;
  readonly inputs: unknown;
  readonly inputsHash: string;
  readonly steps: readonly AppliedStep[];
  readonly receipts: readonly Receipt[];
  readonly checkpoints: readonly PortfolioSnapshot[];
  readonly finalPortfolio: PortfolioSnapshot;
  readonly businessDigest: string;
}

export interface GoldenRun {
  readonly schemaVersion: string;
  readonly fixtureId: "G01";
  readonly fixtureVersion: string;
  readonly engineVersion: string;
  readonly calendar: { readonly calendarId: string; readonly version: string };
  readonly cases: readonly GoldenCase[];
  readonly businessDigest: string;
  readonly checksums: {
    readonly inputs: string;
    readonly steps: string;
    readonly journal: string;
    readonly receipts: string;
    readonly checkpoints: string;
  };
}

function caseDigest(params: {
  caseId: string;
  inputsHash: string;
  steps: readonly AppliedStep[];
  receipts: readonly Receipt[];
  checkpoints: readonly PortfolioSnapshot[];
  finalPortfolio: PortfolioSnapshot;
}): string {
  return hashJson({
    caseId: params.caseId,
    inputsHash: params.inputsHash,
    steps: params.steps,
    receipts: params.receipts,
    checkpoints: params.checkpoints,
    finalPortfolio: params.finalPortfolio,
  });
}

export interface BuildG01EvidenceParams {
  readonly scenario: G01Scenario;
  readonly redemptionScenario: G01RedemptionScenario;
  readonly calendarFixture: CalendarFixture;
  readonly calendar: DealingCalendar;
  readonly g01Steps: readonly AppliedStep[];
  readonly g01Receipts: readonly Receipt[];
  readonly g01Checkpoints: readonly PortfolioSnapshot[];
  readonly g01FinalPortfolio: PortfolioSnapshot;
  readonly redemptionSteps: readonly AppliedStep[];
  readonly redemptionReceipt: Receipt;
  readonly redemptionFinalPortfolio: PortfolioSnapshot;
}

/** Builds the deterministic G01 golden-run evidence object. */
export function buildG01Evidence(params: BuildG01EvidenceParams): GoldenRun {
  const g01Inputs = {
    fixtureId: params.scenario.fixtureId,
    fixtureVersion: params.scenario.fixtureVersion,
    calendar: params.calendarFixture,
    accounts: params.scenario.accounts,
    marks: params.scenario.marks,
    seed: params.scenario.seed,
    spot: params.scenario.spot,
    fund: params.scenario.fund,
    expected: params.scenario.expected,
  };
  const redemptionInputs = {
    baseCase: params.scenario.fixtureId,
    fixtureId: params.redemptionScenario.fixtureId,
    fixtureVersion: params.redemptionScenario.fixtureVersion,
    orderId: params.redemptionScenario.orderId,
    investorId: params.redemptionScenario.investorId,
    unitsBase: params.redemptionScenario.unitsBase,
    requestedAt: params.redemptionScenario.requestedAt,
    cutoffTimeUtc: params.redemptionScenario.cutoffTimeUtc,
    nav: params.redemptionScenario.nav,
    settledAt: params.redemptionScenario.settledAt,
    expected: params.redemptionScenario.expected,
  };

  const g01InputsHash = hashJson(g01Inputs);
  const redemptionInputsHash = hashJson(redemptionInputs);
  const g01CaseContent = {
    caseId: "G01",
    inputsHash: g01InputsHash,
    steps: params.g01Steps,
    receipts: params.g01Receipts,
    checkpoints: params.g01Checkpoints,
    finalPortfolio: params.g01FinalPortfolio,
  };
  const g01Case: GoldenCase = {
    caseId: "G01",
    title: "One investor, one spot fill and one fund lifecycle",
    inputs: g01Inputs,
    inputsHash: g01InputsHash,
    steps: params.g01Steps,
    receipts: params.g01Receipts,
    checkpoints: params.g01Checkpoints,
    finalPortfolio: params.g01FinalPortfolio,
    businessDigest: caseDigest(g01CaseContent),
  };
  const redemptionCaseContent = {
    caseId: "G01-R",
    inputsHash: redemptionInputsHash,
    steps: params.redemptionSteps,
    receipts: [params.redemptionReceipt],
    checkpoints: [params.redemptionFinalPortfolio],
    finalPortfolio: params.redemptionFinalPortfolio,
  };
  const redemptionCase: GoldenCase = {
    caseId: "G01-R",
    title: "Separate redemption case at the next applicable NAV",
    inputs: redemptionInputs,
    inputsHash: redemptionInputsHash,
    steps: params.redemptionSteps,
    receipts: [params.redemptionReceipt],
    checkpoints: [params.redemptionFinalPortfolio],
    finalPortfolio: params.redemptionFinalPortfolio,
    businessDigest: caseDigest(redemptionCaseContent),
  };

  const cases = [g01Case, redemptionCase];
  const allSteps = cases.flatMap((item) => item.steps);
  const allReceipts = cases.flatMap((item) => item.receipts);
  const allCheckpoints = cases.flatMap((item) => item.checkpoints);
  const businessDigest = hashJson({
    schemaVersion: GOLDEN_RUN_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    fixtureId: "G01",
    fixtureVersion: params.scenario.fixtureVersion,
    calendar: params.calendar,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      inputsHash: item.inputsHash,
      businessDigest: item.businessDigest,
    })),
  });

  return {
    schemaVersion: GOLDEN_RUN_SCHEMA_VERSION,
    fixtureId: "G01",
    fixtureVersion: params.scenario.fixtureVersion,
    engineVersion: ENGINE_VERSION,
    calendar: {
      calendarId: params.calendar.calendarId,
      version: params.calendar.version,
    },
    cases,
    businessDigest,
    checksums: {
      inputs: hashJson(cases.map((item) => item.inputsHash)),
      steps: hashJson(allSteps),
      journal: hashJson(allSteps.flatMap((step) => step.journal)),
      receipts: hashJson(allReceipts),
      checkpoints: hashJson(allCheckpoints),
    },
  };
}

/** Recomputes the deterministic bytes of the golden-run evidence file. */
export function serializeGoldenRun(run: GoldenRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

export function serializeEvidenceJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function fileSha256(text: string): string {
  return sha256Hex(text);
}

export interface EvidenceFileRef {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface EvidenceManifest {
  readonly schemaVersion: string;
  readonly packId: string;
  readonly engineVersion: string;
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly businessDigest: string;
  readonly checklist: readonly string[];
  readonly inputs: readonly EvidenceFileRef[];
  readonly files: readonly EvidenceFileRef[];
}

/** Normalizes --pack input: a pack directory or a path to its manifest.json. */
export function resolvePackDirectory(pack: string): string {
  let trimmed = pack.trim();
  // Strip trailing separators without a backtracking regular expression.
  while (trimmed.length > 1 && trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  const manifestSuffix = "/manifest.json";
  if (trimmed === "manifest.json") {
    return ".";
  }
  if (trimmed.endsWith(manifestSuffix)) {
    return trimmed.slice(0, -manifestSuffix.length);
  }
  return trimmed;
}

export function buildEvidenceManifest(params: {
  packId: string;
  run: GoldenRun;
  inputFiles: readonly EvidenceFileRef[];
  files: readonly EvidenceFileRef[];
}): EvidenceManifest {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    packId: params.packId,
    engineVersion: ENGINE_VERSION,
    fixtureId: params.run.fixtureId,
    fixtureVersion: params.run.fixtureVersion,
    businessDigest: params.run.businessDigest,
    checklist: [
      "G01 spendable cash 799.95 after the spot fill",
      "G01 reserved cash 300.00 while awaiting NAV",
      "G01 0.100000 tWETH and 3.125000 eFUND at the closing marks",
      "G01 redemption case 597.95 spendable and 2.125000 units",
      "Journal balances to zero per asset",
      "Canonical business digest reproduced by pnpm verify",
    ],
    inputs: params.inputFiles,
    files: params.files,
  };
}

export interface DealingCaseSerialized {
  readonly caseId: string;
  readonly description: string;
  readonly calendarId: string;
  readonly requestedAt: string;
  readonly baseline: { readonly dealingDate: string; readonly reason: string };
  readonly candidate: { readonly dealingDate: string; readonly reason: string };
  readonly expected: BoundaryCasesFixture["cases"][number]["expected"];
  readonly pass: boolean;
}

export interface DealingCasesEvidence {
  readonly schemaVersion: string;
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly engineVersion: string;
  readonly calendarIds: readonly string[];
  readonly cases: readonly DealingCaseSerialized[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly businessDigest: string;
}

/** Builds the A02 boundary-case evidence object. */
export function buildDealingCasesEvidence(params: {
  fixture: BoundaryCasesFixture;
  calendars: readonly CalendarFixture[];
  results: readonly BoundaryCaseResult[];
}): DealingCasesEvidence {
  const cases: DealingCaseSerialized[] = params.results.map((result) => ({
    caseId: result.caseId,
    description: result.description,
    calendarId: result.calendarId,
    requestedAt: result.requestedAt,
    baseline: result.baseline,
    candidate: result.candidate,
    expected: result.expected,
    pass: result.pass,
  }));
  const passed = cases.filter((item) => item.pass).length;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    fixtureId: params.fixture.fixtureId,
    fixtureVersion: params.fixture.fixtureVersion,
    engineVersion: ENGINE_VERSION,
    calendarIds: params.calendars.map((calendar) => calendar.calendarId),
    cases,
    summary: { total: cases.length, passed, failed: cases.length - passed },
    businessDigest: hashJson(cases),
  };
}

/** True when canonical JSON of both values is identical. */
export function sameCanonicalJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
