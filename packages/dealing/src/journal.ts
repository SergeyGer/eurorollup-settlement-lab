/**
 * Double-entry journal for the synthetic settlement ledger.
 *
 * Every posted movement increases (+) or decreases (-) one account. Each event
 * must balance to zero per asset, including issuance and burn control accounts
 * (specification, section 08).
 */
import type { AssetId } from "./assets.js";
import { DealingError } from "./errors.js";
import { parseBaseUnits } from "./money.js";

export type JournalAccountKind =
  | "investor"
  | "dealer"
  | "fundEscrow"
  | "issuerTreasury"
  | "feeRecipient"
  | "issuanceControl";

export interface JournalAccount {
  readonly kind: JournalAccountKind;
  readonly accountId: string;
}

export function accountKey(account: JournalAccount): string {
  return `${account.kind}:${account.accountId}`;
}

export interface Posting {
  readonly account: JournalAccount;
  readonly assetId: AssetId;
  /** Signed amount in asset base units, serialized as an integer string. */
  readonly amountBase: string;
}

export interface JournalEntry {
  readonly entryId: string;
  readonly stepId: string;
  readonly orderId?: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly description: string;
  readonly postings: readonly Posting[];
}

export function makePosting(
  account: JournalAccount,
  assetId: AssetId,
  amountBase: bigint,
): Posting {
  return Object.freeze({
    account,
    assetId,
    amountBase: amountBase.toString(),
  });
}

/** Builds a journal entry; postings with a zero amount are dropped. */
export function makeJournalEntry(params: {
  entryId: string;
  stepId: string;
  orderId?: string;
  occurredAt: string;
  eventType: string;
  description: string;
  postings: readonly Posting[];
}): JournalEntry {
  const postings = params.postings
    .filter((posting) => parseBaseUnits(posting.amountBase) !== 0n)
    .slice()
    .sort((a, b) => {
      const left = `${accountKey(a.account)}|${a.assetId}`;
      const right = `${accountKey(b.account)}|${b.assetId}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (postings.length === 0) {
    throw new DealingError("INVALID_EVENT", "Journal entry must contain at least one posting", {
      entryId: params.entryId,
    });
  }
  return Object.freeze({
    entryId: params.entryId,
    stepId: params.stepId,
    ...(params.orderId === undefined ? {} : { orderId: params.orderId }),
    occurredAt: params.occurredAt,
    eventType: params.eventType,
    description: params.description,
    postings: Object.freeze(postings),
  });
}

export interface AssetImbalance {
  readonly assetId: AssetId;
  readonly sumBase: string;
}

/** Returns per-asset imbalances; empty when the journal is balanced. */
export function findImbalances(entries: readonly JournalEntry[]): AssetImbalance[] {
  const sums = new Map<AssetId, bigint>();
  for (const entry of entries) {
    for (const posting of entry.postings) {
      const current = sums.get(posting.assetId) ?? 0n;
      sums.set(posting.assetId, current + parseBaseUnits(posting.amountBase));
    }
  }
  const imbalances: AssetImbalance[] = [];
  for (const [assetId, sum] of sums) {
    if (sum !== 0n) {
      imbalances.push({ assetId, sumBase: sum.toString() });
    }
  }
  return imbalances;
}

/** Throws JOURNAL_IMBALANCE when any asset does not net to zero. */
export function assertBalancedJournal(entries: readonly JournalEntry[]): void {
  const imbalances = findImbalances(entries);
  if (imbalances.length > 0) {
    throw new DealingError("JOURNAL_IMBALANCE", "Journal does not balance per asset", {
      imbalances,
    });
  }
}

export interface AccountBalance {
  readonly account: JournalAccount;
  readonly assetId: AssetId;
  readonly balanceBase: string;
}

/** Computes account balances from the journal. */
export function accountBalances(entries: readonly JournalEntry[]): AccountBalance[] {
  const accountMap = new Map<string, JournalAccount>();
  const sums = new Map<string, bigint>();
  for (const entry of entries) {
    for (const posting of entry.postings) {
      const key = `${accountKey(posting.account)}|${posting.assetId}`;
      accountMap.set(key, posting.account);
      sums.set(key, (sums.get(key) ?? 0n) + parseBaseUnits(posting.amountBase));
    }
  }
  const balances: AccountBalance[] = [];
  for (const [key, sum] of sums) {
    const [accountPart, assetPart] = key.split("|");
    const account = accountMap.get(key);
    if (account === undefined || accountPart === undefined || assetPart === undefined) {
      continue;
    }
    balances.push({
      account,
      assetId: assetPart as AssetId,
      balanceBase: sum.toString(),
    });
  }
  return balances.sort((a, b) => {
    const left = `${accountKey(a.account)}|${a.assetId}`;
    const right = `${accountKey(b.account)}|${b.assetId}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
