/**
 * Settlement domain events.
 *
 * Events are ordered, identified and replayed; replay uses the fixture
 * observation time, never wall-clock time. Every event carries its id so a
 * duplicate submission cannot create a second business effect.
 */
import type { AssetId } from "./assets.js";
import type { JournalAccount } from "./journal.js";

export type SpotSide = "BUY" | "SELL";

export interface EventBase {
  readonly eventId: string;
  readonly occurredAt: string;
}

export type SettlementEvent =
  | (EventBase & {
      readonly type: "account.seeded";
      readonly account: JournalAccount;
      readonly assetId: AssetId;
      readonly amountBase: string;
    })
  | (EventBase & {
      readonly type: "spot.quote.issued";
      readonly orderId: string;
      readonly account: JournalAccount;
      readonly side: SpotSide;
      readonly amountBase: string;
      readonly priceBase: string;
      readonly priceAsOf: string;
      readonly expiresAt: string;
      readonly chargeBase: string;
      /** Minimum cash proceeds for a reverse quote; the fill is refused below it. */
      readonly minProceedsBase?: string;
    })
  | (EventBase & {
      readonly type: "spot.order.filled";
      readonly orderId: string;
    })
  | (EventBase & {
      readonly type: "fund.subscription.requested";
      readonly orderId: string;
      readonly account: JournalAccount;
      readonly cashBase: string;
      readonly cutoffTimeUtc: string;
      readonly indicativeNavBase: string;
    })
  | (EventBase & {
      readonly type: "nav.observed";
      readonly assetId: AssetId;
      readonly valuationDate: string;
      readonly navBase: string;
      readonly sourceTime: string;
      readonly revision: number;
      readonly signer: string;
    })
  | (EventBase & {
      readonly type: "fund.subscription.allocated";
      readonly orderId: string;
    })
  | (EventBase & {
      readonly type: "fund.redemption.requested";
      readonly orderId: string;
      readonly account: JournalAccount;
      readonly unitsBase: string;
      readonly cutoffTimeUtc: string;
    })
  | (EventBase & {
      readonly type: "fund.redemption.settled";
      readonly orderId: string;
    })
  | (EventBase & {
      readonly type: "fund.subscription.cancelled";
      readonly orderId: string;
      readonly reason?: string;
    })
  | (EventBase & {
      readonly type: "fund.redemption.cancelled";
      readonly orderId: string;
      readonly reason?: string;
    });

export type SettlementEventType = SettlementEvent["type"];
