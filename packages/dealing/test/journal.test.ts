import { describe, expect, it } from "vitest";
import {
  DealingError,
  accountBalances,
  accountKey,
  assertBalancedJournal,
  findImbalances,
  makeJournalEntry,
  makePosting,
  type JournalAccount,
} from "../src/index.js";

const investor: JournalAccount = { kind: "investor", accountId: "investor-ada" };
const escrow: JournalAccount = { kind: "fundEscrow", accountId: "fund-escrow" };
const issuance: JournalAccount = { kind: "issuanceControl", accountId: "issuance-control" };

function entry(entryId: string, postings: ReturnType<typeof makePosting>[]) {
  return makeJournalEntry({
    entryId,
    stepId: `step-${entryId}`,
    occurredAt: "2026-11-20T14:00:00Z",
    eventType: "test.event",
    description: "test entry",
    postings,
  });
}

describe("double-entry journal", () => {
  it("balances cash movements and drops zero postings", () => {
    const balanced = entry("je-1", [
      makePosting(investor, "dEUR", -300_000_000n),
      makePosting(escrow, "dEUR", 300_000_000n),
      makePosting(issuance, "dEUR", 0n),
    ]);
    expect(balanced.postings).toHaveLength(2);
    expect(findImbalances([balanced])).toEqual([]);
    assertBalancedJournal([balanced]);
  });

  it("detects a per-asset imbalance", () => {
    const imbalanced = entry("je-2", [
      makePosting(investor, "dEUR", -300_000_000n),
      makePosting(escrow, "dEUR", 299_000_000n),
    ]);
    const imbalances = findImbalances([imbalanced]);
    expect(imbalances).toHaveLength(1);
    expect(imbalances[0]?.assetId).toBe("dEUR");
    expect(() => assertBalancedJournal([imbalanced])).toThrowError(DealingError);
  });

  it("refuses an empty journal entry", () => {
    expect(() => entry("je-3", [makePosting(issuance, "dEUR", 0n)])).toThrowError(DealingError);
  });

  it("computes account balances deterministically", () => {
    const first = entry("je-4", [
      makePosting(investor, "dEUR", 1_000_000_000n),
      makePosting(issuance, "dEUR", -1_000_000_000n),
    ]);
    const second = entry("je-5", [
      makePosting(investor, "dEUR", -300_000_000n),
      makePosting(escrow, "dEUR", 300_000_000n),
    ]);
    const balances = accountBalances([second, first]);
    const investorBalance = balances.find(
      (balance) =>
        accountKey(balance.account) === accountKey(investor) && balance.assetId === "dEUR",
    );
    expect(investorBalance?.balanceBase).toBe("700000000");
  });

  it("sorts postings by account key and asset id", () => {
    const journalEntry = entry("je-6", [
      makePosting(escrow, "eFUND", 1_000_000n),
      makePosting(investor, "dEUR", -1_000_000n),
      makePosting(issuance, "eFUND", -1_000_000n),
      makePosting(investor, "eFUND", 1_000_000n),
    ]);
    const keys = journalEntry.postings.map(
      (posting) => `${accountKey(posting.account)}|${posting.assetId}`,
    );
    expect(keys).toEqual([...keys].sort());
  });
});
