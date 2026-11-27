/**
 * Drafting, revisioning and confirmation binding for the supported rule change.
 *
 * The server owns everything that can be derived: baseline policy version and
 * hash, fixture hash, revision, draft digest and the confirmation digest that
 * binds the visible diff to the baseline and fixture the user reviewed. Text and
 * typed fields come from the client; they are validated against the contract
 * before they can reach the deterministic replay.
 */
import {
  DEFAULT_CUTOFF_TIME_UTC,
  applyCutoffChange,
  cutoffForWeekday,
  hashJson,
  parseUtcInstant,
  policyDigest,
  validateCutoffTimeUtc,
  weekdayCodeOfDate,
  type CalendarFixture,
  type FundDealingPolicy,
  type P01Scenario,
  type PolicyWeekday,
} from "@eurorollup/dealing";
import { PolicyLabError } from "./errors.js";
import { validateProposal } from "./proposal-schema.js";
import type {
  DraftOrigin,
  DraftStatus,
  ManualFields,
  PolicyBaselineRef,
  Proposal,
  ProposalDiff,
  RecordedProposalFixture,
  ReplayDraft,
  ScenarioDraftInput,
  ScenarioFixtureRef,
  UnsupportedProposal,
  ClarifyProposal,
} from "./types.js";
import { DRAFT_SCHEMA_VERSION } from "./version.js";

export function policyBaselineRef(policy: FundDealingPolicy): PolicyBaselineRef {
  return {
    policyId: policy.policyId,
    version: policy.version,
    policyHash: policyDigest(policy),
    weekdayCutoffs: { ...policy.weekdayCutoffs },
  };
}

export function scenarioFixtureRef(
  fixture: P01Scenario,
  calendarFixture: CalendarFixture,
): ScenarioFixtureRef {
  return {
    fixtureId: "P01",
    fixtureVersion: fixture.fixtureVersion,
    fixtureHash: hashJson(fixture),
    calendarId: calendarFixture.calendarId,
    calendarVersion: calendarFixture.version,
    calendarHash: hashJson(calendarFixture),
  };
}

/** Cutoff for a request instant: the weekday's cutoff, or the default at weekends. */
export function cutoffForRequest(policy: FundDealingPolicy, requestedAt: string): string {
  const weekday = weekdayCodeOfDate(parseUtcInstant(requestedAt).date);
  if (weekday === "SAT" || weekday === "SUN") {
    return DEFAULT_CUTOFF_TIME_UTC;
  }
  return policy.weekdayCutoffs[weekday];
}

function clarifyDraft(message: string, missingFields: readonly string[]): ClarifyProposal {
  return { status: "clarify", question: message, missingFields };
}

function unsupported(reasonCode: UnsupportedProposal["reasonCode"]): UnsupportedProposal {
  return { status: "unsupported", reasonCode };
}

function parseManualProposal(fields: ManualFields): Proposal {
  const missingFields: string[] = [];
  if (fields.weekday === undefined || fields.weekday.trim() === "") {
    missingFields.push("weekday");
  }
  if (fields.timeUtc === undefined || fields.timeUtc.trim() === "") {
    missingFields.push("timeUtc");
  }
  if (fields.timezone === undefined || fields.timezone.trim() === "") {
    missingFields.push("timezone");
  }
  if (missingFields.length > 0) {
    return clarifyDraft(
      "Which weekday, UTC time and timezone should the cutoff change use? This release supports one weekday and whole-minute UTC times.",
      missingFields,
    );
  }
  const timezone = (fields.timezone ?? "").trim().toUpperCase();
  if (timezone !== "UTC") {
    return clarifyDraft(
      "Only UTC is supported in release 1.0. Which UTC time should the cutoff move to?",
      ["timezone"],
    );
  }
  const weekday = (fields.weekday ?? "").trim().toUpperCase();
  const supportedWeekdays = ["MON", "TUE", "WED", "THU", "FRI"];
  if (!supportedWeekdays.includes(weekday)) {
    return unsupported("UNSUPPORTED_WEEKDAY");
  }
  const timeUtc = (fields.timeUtc ?? "").trim();
  if (validateCutoffTimeUtc(timeUtc).length > 0) {
    return unsupported("OUT_OF_RANGE");
  }
  if (
    fields.expectedTimeUtc !== undefined &&
    validateCutoffTimeUtc(fields.expectedTimeUtc.trim()).length > 0
  ) {
    return unsupported("OUT_OF_RANGE");
  }
  return {
    status: "proposed",
    operation: "set_subscription_cutoff",
    asset: "eFUND",
    weekday: weekday as PolicyWeekday,
    timeUtc,
    timezone: "UTC",
    ...(fields.expectedTimeUtc === undefined
      ? {}
      : { expectedTimeUtc: fields.expectedTimeUtc.trim() }),
  };
}

export interface BuildDraftParams {
  readonly fixture: P01Scenario;
  readonly calendarFixture: CalendarFixture;
  readonly baselinePolicy: FundDealingPolicy;
  readonly origin: DraftOrigin;
  readonly label: string;
  readonly question: string | null;
  readonly proposal: Proposal;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly parentDraftDigest: string | null;
  readonly createdAt: string;
}

/** Evaluates one proposal against the baseline and builds a revisioned draft. */
export function buildDraft(params: BuildDraftParams): ReplayDraft {
  const validation = validateProposal(params.proposal);
  if (!validation.valid) {
    throw new PolicyLabError(
      params.origin === "recorded" ? "INVALID_RECORDED_PROPOSAL" : "INVALID_PROPOSAL",
      validation.errors.join("; "),
      { errors: validation.errors },
    );
  }
  const baseline = policyBaselineRef(params.baselinePolicy);
  const fixture = scenarioFixtureRef(params.fixture, params.calendarFixture);

  let status: DraftStatus;
  let diff: ProposalDiff | null = null;
  let clarify: ReplayDraft["clarify"] = null;
  let unsupportedReasonCode: string | null = null;

  if (params.proposal.status === "clarify") {
    status = "clarify";
    clarify = {
      question: params.proposal.question,
      missingFields: [...params.proposal.missingFields],
    };
  } else if (params.proposal.status === "unsupported") {
    status = "unsupported";
    unsupportedReasonCode = params.proposal.reasonCode;
  } else {
    const currentCutoff = cutoffForWeekday(params.baselinePolicy, params.proposal.weekday);
    if (
      params.proposal.expectedTimeUtc !== undefined &&
      params.proposal.expectedTimeUtc !== currentCutoff
    ) {
      throw new PolicyLabError(
        "PRIOR_TIME_MISMATCH",
        `The stated prior cutoff ${params.proposal.expectedTimeUtc} does not match the baseline cutoff ${currentCutoff} for ${params.proposal.weekday}`,
        {
          statedPriorTime: params.proposal.expectedTimeUtc,
          baselineCutoff: currentCutoff,
          weekday: params.proposal.weekday,
        },
      );
    }
    const changeResult = applyCutoffChange(params.baselinePolicy, {
      operation: params.proposal.operation,
      asset: params.proposal.asset,
      weekday: params.proposal.weekday,
      timeUtc: params.proposal.timeUtc,
      timezone: params.proposal.timezone,
    });
    if (changeResult.kind === "REJECTED") {
      throw new PolicyLabError("INVALID_PROPOSAL", changeResult.errors.join("; "), {
        errors: changeResult.errors,
      });
    }
    if (changeResult.kind === "NO_CHANGE") {
      status = "no_change";
      diff = {
        asset: "eFUND",
        orderType: "FUND_SUBSCRIPTION",
        weekday: params.proposal.weekday,
        oldTimeUtc: currentCutoff,
        newTimeUtc: params.proposal.timeUtc,
        timezone: "UTC",
      };
    } else {
      status = "proposed";
      diff = {
        asset: "eFUND",
        orderType: "FUND_SUBSCRIPTION",
        weekday: params.proposal.weekday,
        oldTimeUtc: currentCutoff,
        newTimeUtc: params.proposal.timeUtc,
        timezone: "UTC",
      };
    }
  }

  const draftDigest = hashJson({
    schemaVersion: DRAFT_SCHEMA_VERSION,
    revision: params.revision,
    origin: params.origin,
    status,
    proposal: params.proposal,
    diff,
    clarify,
    unsupportedReasonCode,
    baseline,
    fixture,
  });
  const confirmationDigest = hashJson({
    draftDigest,
    revision: params.revision,
    baselinePolicyHash: baseline.policyHash,
    fixtureHash: fixture.fixtureHash,
    calendarHash: fixture.calendarHash,
  });
  return {
    scenarioId: null,
    revision: params.revision,
    origin: params.origin,
    status,
    label: params.label,
    question: params.question,
    proposal: params.proposal,
    diff,
    clarify,
    unsupportedReasonCode,
    baseline,
    fixture,
    draftDigest,
    confirmationDigest,
    parentRevision: params.parentRevision,
    parentDraftDigest: params.parentDraftDigest,
    createdAt: params.createdAt,
  };
}

export interface CreateDraftParams {
  readonly fixture: P01Scenario;
  readonly calendarFixture: CalendarFixture;
  readonly baselinePolicy: FundDealingPolicy;
  readonly input: ScenarioDraftInput;
  readonly recordedProposal?: RecordedProposalFixture;
  readonly createdAt: string;
}

/** Creates revision 1 of a scenario draft from a recorded preset or manual fields. */
export function createDraft(params: CreateDraftParams): ReplayDraft {
  if (params.input.fixtureId !== "P01" || params.fixture.fixtureId !== "P01") {
    throw new PolicyLabError(
      "UNSUPPORTED_FIXTURE",
      "Release 1.0 of the deterministic Policy Lab supports fixture P01 only",
      { fixtureId: params.input.fixtureId },
    );
  }
  if (params.input.mode === "live") {
    throw new PolicyLabError(
      "LIVE_MODEL_NOT_CONFIGURED",
      "The local model adapter is not configured; use the recorded preset or a manual edit",
    );
  }
  if (params.input.mode === "recorded") {
    if (params.recordedProposal === undefined) {
      throw new PolicyLabError(
        "RECORDED_PROPOSAL_MISSING",
        "Recorded mode requires the bundled recorded proposal fixture",
      );
    }
    return buildDraft({
      fixture: params.fixture,
      calendarFixture: params.calendarFixture,
      baselinePolicy: params.baselinePolicy,
      origin: "recorded",
      label: params.recordedProposal.label,
      question: params.recordedProposal.question,
      proposal: params.recordedProposal.proposal,
      revision: 1,
      parentRevision: null,
      parentDraftDigest: null,
      createdAt: params.createdAt,
    });
  }
  const proposal = parseManualProposal(params.input.manualFields ?? {});
  return buildDraft({
    fixture: params.fixture,
    calendarFixture: params.calendarFixture,
    baselinePolicy: params.baselinePolicy,
    origin: "manual",
    label: "Manual edit",
    question: params.input.question ?? null,
    proposal,
    revision: 1,
    parentRevision: null,
    parentDraftDigest: null,
    createdAt: params.createdAt,
  });
}

export interface EditDraftParams {
  readonly previous: ReplayDraft;
  readonly fixture: P01Scenario;
  readonly calendarFixture: CalendarFixture;
  readonly baselinePolicy: FundDealingPolicy;
  readonly fields: ManualFields;
  readonly createdAt: string;
}

/**
 * Applies a manual edit as a new revision. The manual edit keeps a link to the
 * parent revision and draft digest.
 */
export function editDraft(params: EditDraftParams): ReplayDraft {
  if (params.previous.status === "unsupported") {
    throw new PolicyLabError(
      "INVALID_DRAFT_STATE",
      "An unsupported proposal cannot be edited into a runnable proposal in this release",
    );
  }
  const proposal = parseManualProposal(params.fields);
  return buildDraft({
    fixture: params.fixture,
    calendarFixture: params.calendarFixture,
    baselinePolicy: params.baselinePolicy,
    origin: "manual",
    label: "Manual edit",
    question: params.previous.question,
    proposal,
    revision: params.previous.revision + 1,
    parentRevision: params.previous.revision,
    parentDraftDigest: params.previous.draftDigest,
    createdAt: params.createdAt,
  });
}

/** True when a run request binds the current revision and confirmation digest. */
export function isCurrentConfirmation(params: {
  draft: ReplayDraft;
  revision: number;
  confirmationDigest: string;
}): boolean {
  return (
    params.draft.revision === params.revision &&
    params.draft.confirmationDigest === params.confirmationDigest
  );
}

export function describeDraft(draft: ReplayDraft): string {
  if (draft.status === "proposed" && draft.diff !== null) {
    return `eFUND ${draft.diff.orderType} cutoff ${draft.diff.weekday} ${draft.diff.oldTimeUtc} -> ${draft.diff.newTimeUtc} ${draft.diff.timezone} (fixture ${draft.fixture.fixtureId} v${draft.fixture.fixtureVersion})`;
  }
  if (draft.status === "no_change") {
    return "The proposed change equals the current rule (NO_CHANGE)";
  }
  if (draft.status === "clarify" && draft.clarify !== null) {
    return `Clarification required: ${draft.clarify.question}`;
  }
  return `Unsupported: ${draft.unsupportedReasonCode ?? "unknown"}`;
}
