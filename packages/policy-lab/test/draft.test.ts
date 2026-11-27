/**
 * Drafting, revisioning, clarification and confirmation-binding tests.
 */
import { describe, expect, it } from "vitest";
import { createBaselinePolicy } from "@eurorollup/dealing";
import {
  createDraft,
  editDraft,
  isCurrentConfirmation,
  policyFromFixture,
  PolicyLabError,
  PROPOSAL_JSON_SCHEMA,
  validateProposal,
  type ReplayDraft,
} from "../src/index.js";
import type { CalendarFixture, P01Scenario } from "@eurorollup/dealing";
import p01Json from "../../../fixtures/p01/scenario.json";
import labUtc1Json from "../../../fixtures/calendar/LAB-UTC-1.json";
import recordedJson from "../../../fixtures/policy-lab/p01-recorded-proposal.json";
import type { RecordedProposalFixture } from "../src/types.js";

const fixture = p01Json as unknown as P01Scenario;
const calendarFixture = labUtc1Json as unknown as CalendarFixture;
const recorded = recordedJson as unknown as RecordedProposalFixture;
const baselinePolicy = createBaselinePolicy();
const createdAt = "2026-11-20T15:00:00Z";

function createRecorded(): ReplayDraft {
  return createDraft({
    fixture,
    calendarFixture,
    baselinePolicy,
    input: { fixtureId: "P01", mode: "recorded" },
    recordedProposal: recorded,
    createdAt,
  });
}

describe("recorded proposal draft", () => {
  it("produces the Friday 16:00 to 15:00 diff as revision 1", () => {
    const draft = createRecorded();
    expect(draft.status).toBe("proposed");
    expect(draft.origin).toBe("recorded");
    expect(draft.revision).toBe(1);
    expect(draft.diff).toEqual({
      asset: "eFUND",
      orderType: "FUND_SUBSCRIPTION",
      weekday: "FRI",
      oldTimeUtc: "16:00",
      newTimeUtc: "15:00",
      timezone: "UTC",
    });
    expect(draft.baseline.version).toBe(1);
    expect(draft.fixture.fixtureId).toBe("P01");
  });

  it("binds the confirmation digest to revision, baseline and fixture", () => {
    const first = createRecorded();
    const second = createRecorded();
    expect(first.draftDigest).toBe(second.draftDigest);
    expect(first.confirmationDigest).toBe(second.confirmationDigest);
    expect(first.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      isCurrentConfirmation({
        draft: first,
        revision: 1,
        confirmationDigest: first.confirmationDigest,
      }),
    ).toBe(true);
    expect(
      isCurrentConfirmation({
        draft: first,
        revision: 2,
        confirmationDigest: first.confirmationDigest,
      }),
    ).toBe(false);
  });

  it("rejects a stated prior time that disagrees with the baseline", () => {
    expect(() =>
      createDraft({
        fixture,
        calendarFixture,
        baselinePolicy,
        input: { fixtureId: "P01", mode: "recorded" },
        recordedProposal: {
          ...recorded,
          proposal: {
            status: "proposed",
            operation: "set_subscription_cutoff",
            asset: "eFUND",
            weekday: "FRI",
            timeUtc: "15:00",
            timezone: "UTC",
            expectedTimeUtc: "14:00",
          },
        },
        createdAt,
      }),
    ).toThrowError(PolicyLabError);
  });

  it("returns NO_CHANGE when the proposal equals the current rule", () => {
    const draft = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: { fixtureId: "P01", mode: "recorded" },
      recordedProposal: {
        ...recorded,
        proposal: {
          status: "proposed",
          operation: "set_subscription_cutoff",
          asset: "eFUND",
          weekday: "FRI",
          timeUtc: "16:00",
          timezone: "UTC",
        },
      },
      createdAt,
    });
    expect(draft.status).toBe("no_change");
  });

  it("passes clarification and unsupported dispositions through", () => {
    const clarify = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: { fixtureId: "P01", mode: "recorded" },
      recordedProposal: {
        ...recorded,
        proposal: { status: "clarify", question: "Which weekday?", missingFields: ["weekday"] },
      },
      createdAt,
    });
    expect(clarify.status).toBe("clarify");
    expect(clarify.clarify?.missingFields).toEqual(["weekday"]);
    expect(clarify.diff).toBeNull();

    const unsupported = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: { fixtureId: "P01", mode: "recorded" },
      recordedProposal: {
        ...recorded,
        proposal: { status: "unsupported", reasonCode: "MULTIPLE_CHANGES" },
      },
      createdAt,
    });
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.unsupportedReasonCode).toBe("MULTIPLE_CHANGES");
  });
});

describe("manual drafts and revisions", () => {
  it("creates a proposed draft from typed fields", () => {
    const draft = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: {
        fixtureId: "P01",
        mode: "manual",
        manualFields: { weekday: "FRI", timeUtc: "15:30", timezone: "UTC" },
      },
      createdAt,
    });
    expect(draft.origin).toBe("manual");
    expect(draft.status).toBe("proposed");
    expect(draft.diff?.newTimeUtc).toBe("15:30");
  });

  it("asks for clarification when a field is missing", () => {
    const draft = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: {
        fixtureId: "P01",
        mode: "manual",
        manualFields: { weekday: "FRI" },
      },
      createdAt,
    });
    expect(draft.status).toBe("clarify");
    expect(draft.clarify?.missingFields).toEqual(["timeUtc", "timezone"]);
    expect(draft.clarify?.question.length).toBeGreaterThan(10);
  });

  it("marks unsupported weekdays and out-of-range times as unsupported", () => {
    const saturday = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: {
        fixtureId: "P01",
        mode: "manual",
        manualFields: { weekday: "SAT", timeUtc: "15:00", timezone: "UTC" },
      },
      createdAt,
    });
    expect(saturday.status).toBe("unsupported");
    expect(saturday.unsupportedReasonCode).toBe("UNSUPPORTED_WEEKDAY");

    const late = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: {
        fixtureId: "P01",
        mode: "manual",
        manualFields: { weekday: "FRI", timeUtc: "18:00", timezone: "UTC" },
      },
      createdAt,
    });
    expect(late.status).toBe("unsupported");
    expect(late.unsupportedReasonCode).toBe("OUT_OF_RANGE");
  });

  it("creates a new revision on edit and keeps the parent link", () => {
    const first = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy,
      input: {
        fixtureId: "P01",
        mode: "manual",
        manualFields: { weekday: "FRI", timeUtc: "15:00", timezone: "UTC" },
      },
      createdAt,
    });
    const second = editDraft({
      previous: first,
      fixture,
      calendarFixture,
      baselinePolicy,
      fields: { weekday: "FRI", timeUtc: "15:30", timezone: "UTC" },
      createdAt: "2026-11-20T15:05:00Z",
    });
    expect(second.revision).toBe(2);
    expect(second.origin).toBe("manual");
    expect(second.parentRevision).toBe(1);
    expect(second.parentDraftDigest).toBe(first.draftDigest);
    expect(second.diff?.newTimeUtc).toBe("15:30");
    expect(second.draftDigest).not.toBe(first.draftDigest);
    expect(second.confirmationDigest).not.toBe(first.confirmationDigest);
  });

  it("refuses live mode until the model adapter exists", () => {
    expect(() =>
      createDraft({
        fixture,
        calendarFixture,
        baselinePolicy,
        input: { fixtureId: "P01", mode: "live" },
        createdAt,
      }),
    ).toThrowError(PolicyLabError);
  });

  it("refuses unsupported fixtures", () => {
    expect(() =>
      createDraft({
        fixture,
        calendarFixture,
        baselinePolicy,
        input: { fixtureId: "G01", mode: "manual", manualFields: {} },
        createdAt,
      }),
    ).toThrowError(PolicyLabError);
  });

  it("uses the fixture baseline policy when converting fixture policies", () => {
    const converted = policyFromFixture(fixture.baselinePolicy);
    expect(converted.version).toBe(1);
    expect(converted.weekdayCutoffs.FRI).toBe("16:00");
  });
});

describe("proposal contract", () => {
  it("publishes a discriminated JSON Schema with additionalProperties false", () => {
    expect(PROPOSAL_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(PROPOSAL_JSON_SCHEMA.oneOf).toHaveLength(3);
  });

  it("accepts a valid proposal and rejects extra fields", () => {
    const valid = validateProposal({
      status: "proposed",
      operation: "set_subscription_cutoff",
      asset: "eFUND",
      weekday: "FRI",
      timeUtc: "15:00",
      timezone: "UTC",
    });
    expect(valid.valid).toBe(true);

    const extra = validateProposal({
      status: "proposed",
      operation: "set_subscription_cutoff",
      asset: "eFUND",
      weekday: "FRI",
      timeUtc: "15:00",
      timezone: "UTC",
      additional: "nope",
    });
    expect(extra.valid).toBe(false);

    const badTime = validateProposal({
      status: "proposed",
      operation: "set_subscription_cutoff",
      asset: "eFUND",
      weekday: "FRI",
      timeUtc: "17:00",
      timezone: "UTC",
    });
    expect(badTime.valid).toBe(false);
  });

  it("enforces the 500 character text limit for clarifications", () => {
    const longQuestion = validateProposal({
      status: "clarify",
      question: "x".repeat(501),
      missingFields: ["weekday"],
    });
    expect(longQuestion.valid).toBe(false);
  });

  it("rejects unknown unsupported reason codes", () => {
    const invalid = validateProposal({ status: "unsupported", reasonCode: "WHATEVER" });
    expect(invalid.valid).toBe(false);
  });
});
