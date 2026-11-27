/**
 * Browser replay data.
 *
 * The page computes the journey locally from the frozen fixtures with the same
 * pure dealing engine the CLI uses. Nothing here is a recording of a server: it
 * is the deterministic replay of the recorded fixture, labelled as such.
 */
import {
  calendarFromFixture,
  buildG01Engine,
  g01Events,
  g01ReceiptsForEngine,
  investorAccount,
  runG01Redemption,
  type CalendarFixture,
  type G01RedemptionScenario,
  type G01Scenario,
  type PortfolioSnapshot,
  type Receipt,
  type SettlementEngine,
  type SettlementEvent,
} from "@eurorollup/dealing";
import g01ScenarioJson from "../../../../fixtures/g01/scenario.json";
import g01RedemptionJson from "../../../../fixtures/g01/redemption.json";
import labUtc1Json from "../../../../fixtures/calendar/LAB-UTC-1.json";

export const g01Scenario = g01ScenarioJson as unknown as G01Scenario;
export const g01RedemptionScenario = g01RedemptionJson as unknown as G01RedemptionScenario;
export const labUtc1 = labUtc1Json as unknown as CalendarFixture;

export interface ReplayStep {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly description: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly effects: readonly string[];
  readonly journal: ReadonlyArray<{
    readonly entryId: string;
    readonly description: string;
    readonly postings: ReadonlyArray<{
      readonly accountKind: string;
      readonly accountId: string;
      readonly assetId: string;
      readonly amountBase: string;
    }>;
  }>;
  readonly snapshot: PortfolioSnapshot;
  readonly receipt?: Receipt;
}

function receiptForEventType(
  receipts: readonly Receipt[],
  eventType: string,
): Receipt | undefined {
  if (eventType === "spot.order.filled") {
    return receipts.find((receipt) => receipt.orderId === "G01-SPOT-01");
  }
  if (eventType === "fund.subscription.allocated") {
    return receipts.find((receipt) => receipt.orderId === "G01-FUND-01");
  }
  if (eventType === "fund.redemption.settled") {
    return receipts.find((receipt) => receipt.orderId === "G01-RED-01");
  }
  return undefined;
}

function baseStep(step: SettlementEngine["steps"][number], index: number): Omit<ReplayStep, "snapshot"> {
  return {
    id: step.stepId,
    index,
    title: step.title,
    description: step.description,
    occurredAt: step.occurredAt,
    eventType: step.eventType,
    effects: step.businessEffects,
    journal: step.journal.map((entry) => ({
      entryId: entry.entryId,
      description: entry.description,
      postings: entry.postings.map((posting) => ({
        accountKind: posting.account.kind,
        accountId: posting.account.accountId,
        assetId: posting.assetId,
        amountBase: posting.amountBase,
      })),
    })),
  };
}

function collectReplaySteps(params: {
  engine: SettlementEngine;
  events: ReadonlyArray<SettlementEvent>;
  startIndex: number;
}): ReplayStep[] {
  const investor = investorAccount(g01Scenario.accounts.investorId);
  const steps: ReplayStep[] = [];
  let index = params.startIndex;
  for (const event of params.events) {
    params.engine.apply(event);
    const lastStep = params.engine.steps[params.engine.steps.length - 1];
    if (lastStep === undefined) {
      continue;
    }
    const snapshot = params.engine.portfolioSnapshot({
      investor,
      label: event.type,
      at: event.occurredAt,
    });
    steps.push({ ...baseStep(lastStep, index), snapshot });
    index += 1;
  }
  return steps;
}

function attachReceipts(
  steps: readonly ReplayStep[],
  receipts: readonly Receipt[],
): ReplayStep[] {
  return steps.map((step) => {
    const receipt = receiptForEventType(receipts, step.eventType);
    return receipt === undefined ? step : { ...step, receipt };
  });
}

function buildReplays(): { g01: ReplayStep[]; redemption: ReplayStep[] } {
  const calendar = calendarFromFixture(labUtc1);
  const engine = buildG01Engine(g01Scenario, calendar);
  const g01Steps = collectReplaySteps({
    engine,
    events: g01Events(g01Scenario),
    startIndex: 0,
  });
  const g01Receipts = g01ReceiptsForEngine(
    engine,
    g01Scenario.spot.orderId,
    g01Scenario.fund.orderId,
  );
  const g01 = attachReceipts(g01Steps, g01Receipts);

  const redemptionRun = runG01Redemption(
    g01RedemptionScenario,
    engine,
    g01Scenario.accounts.investorId,
  );
  const redemptionEvents = redemptionRun.engine.steps.slice(engine.steps.length);
  const investor = investorAccount(g01Scenario.accounts.investorId);
  const redemptionSteps: ReplayStep[] = redemptionEvents.map((step, offset) => ({
    ...baseStep(step, g01.length + offset),
    snapshot: redemptionRun.engine.portfolioSnapshot({
      investor,
      label: step.title,
      at: step.occurredAt,
    }),
  }));
  const redemption = attachReceipts(redemptionSteps, [redemptionRun.receipt]);
  return { g01, redemption };
}

const replays = buildReplays();

export const g01Replay = replays.g01;
export const redemptionReplay = replays.redemption;

export const fixtureInfo = {
  fixtureId: g01Scenario.fixtureId,
  fixtureVersion: g01Scenario.fixtureVersion,
  redemptionFixtureId: g01RedemptionScenario.fixtureId,
  calendarId: g01Scenario.calendarId,
  calendarVersion: labUtc1.version,
  description: g01Scenario.description,
  redemptionDescription: g01RedemptionScenario.description,
} as const;
