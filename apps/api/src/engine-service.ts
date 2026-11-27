/**
 * Event-sourced engine service.
 *
 * The pure dealing engine is rebuilt from the durable event log on startup. New
 * events are applied to a clone first and only adopted after the transaction
 * that stores the events, journal projection and caller projection commits, so
 * a failed write can never leave business state ahead of the log.
 */
import {
  SettlementEngine,
  formatDisplayAmount,
  parseBaseUnits,
  type AppliedStep,
  type AssetId,
  type DealingCalendar,
  type JournalAccount,
  type JournalEntry,
  type SettlementEvent,
} from "@eurorollup/dealing";
import { ENGINE_ACCOUNT_IDS, type ApiConfig } from "./config.js";
import {
  insertEvent,
  insertJournalEntries,
  readEvents,
  replaceJournal,
  transaction,
  type Database,
} from "./db.js";

export function engineAccounts(config: ApiConfig): {
  dealer: JournalAccount;
  feeRecipient: JournalAccount;
  issuerTreasury: JournalAccount;
  issuanceControl: JournalAccount;
  fundEscrow: JournalAccount;
} {
  return {
    dealer: { kind: "dealer", accountId: ENGINE_ACCOUNT_IDS.dealer },
    feeRecipient: { kind: "feeRecipient", accountId: ENGINE_ACCOUNT_IDS.feeRecipient },
    issuerTreasury: { kind: "issuerTreasury", accountId: ENGINE_ACCOUNT_IDS.issuerTreasury },
    issuanceControl: {
      kind: "issuanceControl",
      accountId: ENGINE_ACCOUNT_IDS.issuanceControl,
    },
    fundEscrow: { kind: "fundEscrow", accountId: ENGINE_ACCOUNT_IDS.fundEscrow },
  };
}

export function investorAccount(accountId: string): JournalAccount {
  return { kind: "investor", accountId };
}

export function createEngine(config: ApiConfig): SettlementEngine {
  return new SettlementEngine({
    calendar: config.calendar,
    accounts: engineAccounts(config),
    marks: {
      tWETH: config.dealerSpotPriceBase,
      eFUND: config.indicativeNavBase,
    },
  });
}

export interface ApplyEventsOptions {
  readonly orderId?: string;
  /**
   * Projection update executed inside the same transaction, with access to the
   * draft engine whose state includes the newly applied events.
   */
  readonly mutate?: (
    steps: readonly AppliedStep[],
    entries: readonly JournalEntry[],
    draft: SettlementEngine,
  ) => void;
}

export class EngineService {
  private readonly db: Database;
  private readonly config: ApiConfig;
  private engineState: SettlementEngine;

  constructor(db: Database, config: ApiConfig) {
    this.db = db;
    this.config = config;
    this.engineState = createEngine(config);
    this.rebuild();
  }

  get state(): SettlementEngine {
    return this.engineState;
  }

  get calendar(): DealingCalendar {
    return this.config.calendar;
  }

  /** Replays the durable event log and refreshes the journal projection. */
  rebuild(): void {
    const engine = createEngine(this.config);
    for (const event of readEvents(this.db)) {
      engine.apply(event);
    }
    this.engineState = engine;
    replaceJournal(this.db, engine.journal);
  }

  /**
   * Applies ordered events atomically: the event log, journal projection and
   * caller projection commit together, then the in-memory engine is swapped.
   */
  applyEvents(
    events: readonly SettlementEvent[],
    options: ApplyEventsOptions = {},
  ): readonly AppliedStep[] {
    if (events.length === 0) {
      return [];
    }
    const draft = this.engineState.clone();
    const steps: AppliedStep[] = events.map((event) => draft.apply(event));
    const entries = steps.flatMap((step) => step.journal);
    transaction(this.db, () => {
      for (const event of events) {
        insertEvent(this.db, event, options.orderId ?? null);
      }
      insertJournalEntries(this.db, entries);
      options.mutate?.(steps, entries, draft);
    });
    this.engineState = draft;
    return steps;
  }

  balanceOf(account: JournalAccount, assetId: AssetId): bigint {
    return this.engineState.balanceOf(account, assetId);
  }

  formatAmount(amount: bigint, assetId: AssetId): string {
    if (assetId === "tWETH") {
      return formatDisplayAmount(amount, 18, 6);
    }
    return formatDisplayAmount(amount, 6, 2);
  }

  parseAmount(value: string): bigint {
    return parseBaseUnits(value);
  }
}
