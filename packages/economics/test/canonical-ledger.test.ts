import { describe, expect, it } from "vitest";
import {
  CanonicalReconciliationLedger,
  NonCanonicalAnchorError,
  type BalanceObservation,
  type LedgerEvent,
  type LedgerSnapshot,
} from "../src/canonical-ledger.js";

const H = (letter: string): string => `0x${letter.repeat(64)}`;

const initialBalances: BalanceObservation[] = [
  { account: "investor", assetId: "dEUR", amountBase: "1000000000" },
  { account: "issuer", assetId: "dEUR", amountBase: "500000000" },
  { account: "dealer", assetId: "tWETH", amountBase: "1000000000000000000" },
  { account: "escrow", assetId: "dEUR", amountBase: "0" },
  { account: "fee", assetId: "dEUR", amountBase: "0" },
];

function event(overrides: Partial<LedgerEvent> & Pick<LedgerEvent, "eventId" | "kind" | "orderId">): LedgerEvent {
  return {
    blockHash: H("a"),
    blockNumber: 1,
    txHash: H("b"),
    logIndex: 0,
    account: "investor",
    counterparty: "escrow",
    assetId: "dEUR",
    amountBase: "0",
    feeBase: "0",
    unitsBase: "0",
    unitsAssetId: "eFUND",
    ...overrides,
  };
}

function snapshot(blockNumber: number, blockHash: string, events: LedgerEvent[]): LedgerSnapshot {
  return { blockNumber, blockHash, parentHash: H("0"), events };
}

function newLedger(): CanonicalReconciliationLedger {
  return new CanonicalReconciliationLedger(CanonicalReconciliationLedger.initialCheckpoint(0, H("0"), initialBalances));
}

describe("canonical reconciliation ledger", () => {
  it("applies reserve/release/allocate and tracks the projection", () => {
    const ledger = newLedger();
    const s1 = snapshot(1, H("1"), [event({ eventId: "e1", kind: "RESERVE", orderId: "A", amountBase: "300000000" })]);
    const s2 = snapshot(2, H("2"), [
      event({ eventId: "e2", kind: "RELEASE", orderId: "A", counterparty: "issuer", amountBase: "300000000", blockNumber: 2, blockHash: H("2") }),
      event({ eventId: "e3", kind: "ALLOCATE", orderId: "A", unitsBase: "3125000", blockNumber: 2, blockHash: H("2") }),
    ]);
    ledger.applySnapshot(s1, H("1"));
    ledger.applySnapshot(s2, H("2"));
    const projection = ledger.projection();
    expect(projection.balances["investor"]!["dEUR"]).toBe("700000000");
    expect(projection.balances["issuer"]!["dEUR"]).toBe("800000000");
    expect(projection.reservations["A"]).toBe("0");
    expect(ledger.checkpoint().releasedReservations["A"]).toBe(1);
  });

  it("rejects a noncanonical anchor", () => {
    const ledger = newLedger();
    const s = snapshot(1, H("f"), []);
    expect(() => ledger.applySnapshot(s, H("1"))).toThrow(NonCanonicalAnchorError);
    expect(ledger.audit().some((entry) => entry.action === "reject-anchor")).toBe(true);
  });

  it("rewinds to the common ancestor, orphans the previous branch and replays the replacement", () => {
    const ledger = newLedger();
    const ancestor: LedgerSnapshot[] = [];
    const previous = [
      snapshot(1, H("1"), [event({ eventId: "e1", kind: "RESERVE", orderId: "A", amountBase: "300000000", blockNumber: 1, blockHash: H("1") })]),
      snapshot(2, H("2"), [
        event({ eventId: "e2", kind: "RELEASE", orderId: "A", counterparty: "issuer", amountBase: "300000000", blockNumber: 2, blockHash: H("2") }),
        event({ eventId: "e3", kind: "ALLOCATE", orderId: "A", unitsBase: "3125000", blockNumber: 2, blockHash: H("2") }),
      ]),
    ];
    const genesisCheckpoint = ledger.checkpoint();
    for (const s of previous) ledger.applySnapshot(s, s.blockHash);
    const replacement = [
      snapshot(1, H("c"), []),
      snapshot(2, H("d"), [
        event({ eventId: "e4", kind: "RESERVE", orderId: "B", amountBase: "200000000", blockNumber: 2, blockHash: H("d") }),
        event({ eventId: "e5", kind: "RELEASE", orderId: "B", counterparty: "issuer", amountBase: "200000000", blockNumber: 2, blockHash: H("d") }),
      ]),
    ];
    const result = ledger.reconcileReorg({
      initialCheckpoint: genesisCheckpoint,
      ancestorSnapshots: ancestor,
      previousBranch: previous,
      replacementBranch: replacement,
      expectedCanonicalHash: (s) => s.blockHash,
    });
    expect(result.orphanedEvents.map((e) => e.eventId)).toEqual(["e1", "e2", "e3"]);
    expect(result.replayedEvents.map((e) => e.eventId)).toEqual(["e4", "e5"]);
    const projection = ledger.projection();
    expect(projection.balances["investor"]!["dEUR"]).toBe("800000000");
    expect(projection.balances["issuer"]!["dEUR"]).toBe("700000000");
    expect(projection.balances["escrow"]!["dEUR"]).toBe("0");
    expect(projection.balances["investor"]!["eFUND"]).toBeUndefined();
    expect(ledger.audit().filter((entry) => entry.action === "orphan")).toHaveLength(2);
  });

  it("releases a reservation exactly once", () => {
    const ledger = newLedger();
    const s1 = snapshot(1, H("1"), [event({ eventId: "e1", kind: "RESERVE", orderId: "A", amountBase: "300000000" })]);
    const s2 = snapshot(2, H("2"), [event({ eventId: "e2", kind: "RELEASE", orderId: "A", counterparty: "issuer", amountBase: "300000000", blockNumber: 2, blockHash: H("2") })]);
    const s3 = snapshot(3, H("3"), [event({ eventId: "e3", kind: "RELEASE", orderId: "A", counterparty: "issuer", amountBase: "300000000", blockNumber: 3, blockHash: H("3") })]);
    ledger.applySnapshot(s1, s1.blockHash);
    ledger.applySnapshot(s2, s2.blockHash);
    const result = ledger.applySnapshot(s3, s3.blockHash);
    expect(result.duplicates).toBe(1);
    expect(ledger.projection().balances["issuer"]!["dEUR"]).toBe("800000000");
    expect(ledger.checkpoint().releasedReservations["A"]).toBe(1);
  });

  it("skips duplicate deliveries and resumes from a checkpoint", () => {
    const ledger = newLedger();
    const s1 = snapshot(1, H("1"), [event({ eventId: "e1", kind: "RESERVE", orderId: "A", amountBase: "100000000" })]);
    ledger.applySnapshot(s1, s1.blockHash);
    const duplicate = ledger.applyDuplicateSnapshot(s1, s1.blockHash);
    expect(duplicate.duplicates).toBe(1);
    const checkpoint = ledger.checkpoint();
    const restored = CanonicalReconciliationLedger.fromCheckpoint(checkpoint);
    const s2 = snapshot(2, H("2"), [event({ eventId: "e2", kind: "RELEASE", orderId: "A", counterparty: "issuer", amountBase: "100000000", blockNumber: 2, blockHash: H("2") })]);
    restored.applySnapshot(s2, s2.blockHash);
    expect(restored.projection().balances["issuer"]!["dEUR"]).toBe("600000000");
    expect(restored.projection().balances["investor"]!["dEUR"]).toBe("900000000");
  });

  it("matches exact-block-hash observations and conserves assets", () => {
    const ledger = newLedger();
    ledger.applySnapshot(snapshot(1, H("1"), [event({ eventId: "e1", kind: "RESERVE", orderId: "A", amountBase: "300000000" })]), H("1"));
    ledger.applySnapshot(snapshot(2, H("2"), [event({ eventId: "e2", kind: "RELEASE", orderId: "A", counterparty: "issuer", amountBase: "300000000", blockNumber: 2, blockHash: H("2") })]), H("2"));
    const observations: BalanceObservation[] = [
      { account: "investor", assetId: "dEUR", amountBase: "700000000" },
      { account: "issuer", assetId: "dEUR", amountBase: "800000000" },
      { account: "escrow", assetId: "dEUR", amountBase: "0" },
      { account: "dealer", assetId: "dEUR", amountBase: "0" },
      { account: "fee", assetId: "dEUR", amountBase: "0" },
      { account: "dealer", assetId: "tWETH", amountBase: "1000000000000000000" },
    ];
    const result = ledger.reconcileBalanceObservations(observations);
    expect(result.conserved).toBe(true);
    expect(result.differences).toEqual([]);
  });
});
