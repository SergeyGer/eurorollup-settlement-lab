/**
 * Browser-side Policy Lab data.
 *
 * The page bundles the frozen P01 fixtures and computes both branches locally
 * with the shared `@eurorollup/policy-lab` package. The comparison digest is
 * compared with the committed CLI evidence pack, so the browser, the CLI and the
 * service are proven to agree at runtime.
 */
import {
  calendarFromFixture,
  createBaselinePolicy,
  applyCutoffChange,
  type CalendarFixture,
  type FundDealingPolicy,
  type P01Scenario,
} from "@eurorollup/dealing";
import {
  buildP01ComparisonPack,
  createDraft,
  editDraft,
  policyFromFixture,
  runP01BoundaryCases,
  runP01Comparison,
  serializeP01ComparisonPack,
  type ManualFields,
  type P01BoundaryFixture,
  type P01ComparisonPack,
  type RecordedProposalFixture,
  type ReplayDraft,
} from "@eurorollup/policy-lab";
import p01Json from "../../../../fixtures/p01/scenario.json";
import labUtc1Json from "../../../../fixtures/calendar/LAB-UTC-1.json";
import labUtc2Json from "../../../../fixtures/calendar/LAB-UTC-2.json";
import boundaryJson from "../../../../fixtures/policy-lab/p01-boundary.json";
import recordedJson from "../../../../fixtures/policy-lab/p01-recorded-proposal.json";
import committedPackJson from "../../../../evidence/policy-lab/p01-comparison.json";

export const FIXTURE_CLOCK_LABEL = "2026-11-20T15:00:00Z";

export const p01Fixture = p01Json as unknown as P01Scenario;
export const labUtc1 = labUtc1Json as unknown as CalendarFixture;
export const labUtc2 = labUtc2Json as unknown as CalendarFixture;
export const p01BoundaryFixture = boundaryJson as unknown as P01BoundaryFixture;
export const recordedProposal = recordedJson as unknown as RecordedProposalFixture;
export const committedP01Pack = committedPackJson as unknown as P01ComparisonPack;

const baselinePolicy: FundDealingPolicy = createBaselinePolicy();
const candidateFixturePolicy = policyFromFixture(p01Fixture.candidatePolicy);
void candidateFixturePolicy;

export function createRecordedDraft(): ReplayDraft {
  return createDraft({
    fixture: p01Fixture,
    calendarFixture: labUtc1,
    baselinePolicy,
    input: { fixtureId: "P01", mode: "recorded" },
    recordedProposal,
    createdAt: FIXTURE_CLOCK_LABEL,
  });
}

export function createManualDraft(fields: ManualFields): ReplayDraft {
  return createDraft({
    fixture: p01Fixture,
    calendarFixture: labUtc1,
    baselinePolicy,
    input: { fixtureId: "P01", mode: "manual", manualFields: fields },
    recordedProposal,
    createdAt: FIXTURE_CLOCK_LABEL,
  });
}

export function applyDraftEdit(previous: ReplayDraft, fields: ManualFields): ReplayDraft {
  return editDraft({
    previous,
    fixture: p01Fixture,
    calendarFixture: labUtc1,
    baselinePolicy,
    fields,
    createdAt: FIXTURE_CLOCK_LABEL,
  });
}

export interface LocalComparisonResult {
  readonly pack: P01ComparisonPack;
  readonly packText: string;
  readonly matchesCommitted: boolean;
  readonly committedPackDigest: string;
}

/** Recomputes both branches in the browser for the confirmed draft. */
export function computeComparison(draft: ReplayDraft): LocalComparisonResult {
  const proposal = draft.proposal;
  if (proposal === null || proposal.status !== "proposed") {
    throw new Error("Only a proposed change can be compared");
  }
  const changeResult = applyCutoffChange(baselinePolicy, {
    operation: proposal.operation,
    asset: proposal.asset,
    weekday: proposal.weekday,
    timeUtc: proposal.timeUtc,
    timezone: proposal.timezone,
  });
  if (changeResult.kind !== "APPLIED") {
    throw new Error(`The confirmed change produced ${changeResult.kind}`);
  }
  const comparison = runP01Comparison({
    fixture: p01Fixture,
    calendarFixture: labUtc1,
    baselinePolicy,
    candidatePolicy: changeResult.policy,
  });
  const boundaryCases = runP01BoundaryCases({
    fixture: p01Fixture,
    boundaryFixture: p01BoundaryFixture,
    calendars: {
      "LAB-UTC-1": labUtc1,
      "LAB-UTC-2": labUtc2,
    },
    baselinePolicy,
    candidatePolicy: changeResult.policy,
  });
  const pack = buildP01ComparisonPack({
    comparison,
    boundaryCases,
    boundaryFixture: p01BoundaryFixture,
  });
  const packText = serializeP01ComparisonPack(pack);
  return {
    pack,
    packText,
    matchesCommitted: pack.packDigest === committedP01Pack.packDigest,
    committedPackDigest: committedP01Pack.packDigest,
  };
}

export const baselineCutoff = baselinePolicy.weekdayCutoffs.FRI;
export const baselinePolicyVersion = baselinePolicy.version;
