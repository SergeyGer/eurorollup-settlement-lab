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

function receiptForStep(receipts: readonly Receipt[], eventType: string): Receipt | undefined {
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

function collectSteps(params: {
  engine: SettlementEngine;
  events: ReadonlyArray<Parameters<SettlementEngine["apply"]>[0]>;
  receipts: readonly Receipt[];
  startIndex: number;
  steps: ReplayStep[];
}): void {
  const investor = investorAccount(g01Scenario.accounts.investorId);
  let offset = params.startIndex;
  for (const event of params.events) {
    params.engine.apply(event);
    const receipt = receiptForStep(params.receipts, event.type);
    const snapshot = params.engine.portfolioSnapshot({
      investor,
      label: event.type,
      at: event.occurredAt,
    });
    const lastStep = params.engine.steps[params.engine.steps.length - 1];
    if (lastStep === undefined) {
      continue;
    }
    params.steps.push({
      id: lastStep.stepId,
      index: offset,
      title: lastStep.title,
      description: lastStep.description,
      occurredAt: lastStep.occurredAt,
      eventType: lastStep.eventType,
      effects: lastStep.businessEffects,
      journal: lastStep.journal.map((entry) => ({
        entryId: entry.entryId,
        description: entry.description,
        postings: entry.postings.map((posting) => ({
          accountKind: posting.account.kind,
          accountId: posting.account.accountId,
          assetId: posting.assetId,
          amountBase: posting.amountBase,
        })),
      })),
      snapshot,
      ...(receipt === undefined ? {} : { receipt }),
    });
    offset += 1;
  }
}

function buildReplays(): { g01: ReplayStep[]; redemption: ReplayStep[] } {
  const calendar = calendarFromFixture(labUtc1);
  const engine = buildG01Engine(g01Scenario, calendar);
  const g01Receipts = g01ReceiptsForEngine(
    engine,
    g01Scenario.spot.orderId,
    g01Scenario.fund.orderId,
  );
  const g01: ReplayStep[] = [];
  collectSteps({ engine, events: g01Events(g01Scenario), receipts: g01Receipts, startIndex: 0, steps: g01 });

  const redemption = runG01Redemption(
    g01RedemptionScenario,
    engine,
    g01Scenario.accounts.investorId,
  );
  const redemptionSteps: ReplayStep[] = [];
  const redemptionEvents = redemption.engine.steps.slice(engine.steps.length);
  const investor = investorAccount(g01Scenario.accounts.investorId);
  let offset = g01.length;
  for (const step of redemptionEvents) {
    const receipt = receiptForStep([redemption.receipt], step.eventType);
    redemptionSteps.push({
      id: step.stepId,
      index: offset,
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
      snapshot: redemption.engine.portfolioSnapshot({
        investor,
        label: step.title,
        at: step.occurredAt,
      }),
      ...(receipt === undefined ? {} : { receipt }),
    });
    offset += 1;
  }
  return { g01, redemption: redemptionSteps };
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
