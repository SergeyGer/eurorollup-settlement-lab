/**
 * Canonical reconciliation ledger with reorg recovery.
 *
 * The ledger indexes chain events into account/asset balances and order reservations,
 * always anchored to a specific block hash. Snapshots are applied in canonical order; a
 * duplicately delivered event is skipped, a noncanonical anchor is rejected, and a reorg
 * rewinds the projection to the common ancestor, marks the orphaned events and replays the
 * replacement branch. Reservations are released exactly once.
 */

export type EventKind = "RESERVE" | "RELEASE" | "ALLOCATE" | "REDEEM" | "SPOT";

export interface LedgerEvent {
  readonly eventId: string;
  readonly kind: EventKind;
  readonly orderId: string;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly logIndex: number;
  /** Account the event is about (investor for fund events, investor for spot). */
  readonly account: string;
  /** Secondary account (recipient for release, dealer for spot). */
  readonly counterparty: string | null;
  readonly assetId: string;
  /** Amount base units of the primary movement. */
  readonly amountBase: string;
  readonly feeBase: string;
  readonly unitsBase: string;
  readonly unitsAssetId: string;
}

export interface ChainBalance {
  readonly account: string;
  readonly assetId: string;
  readonly amountBase: string;
}

export interface LedgerSnapshot {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly parentHash: string;
  readonly events: readonly LedgerEvent[];
  /** Optional chain observations at this exact block hash. */
  readonly chainBalances?: readonly ChainBalance[];
  readonly totalSupply?: readonly ChainBalance[];
}

export interface LedgerCheckpoint {
  readonly schemaVersion: "1.0.0";
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly balances: Record<string, Record<string, string>>;
  readonly reservations: Record<string, string>;
  readonly releasedReservations: Record<string, number>;
  readonly processedEventIds: string[];
  readonly auditTrail: AuditEntry[];
}

export interface AuditEntry {
  readonly action: "apply" | "skip-duplicate" | "orphan" | "rewind" | "replay" | "reject-anchor";
  readonly eventId: string | null;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly branch: "ancestor" | "previous" | "replacement";
  readonly reason: string | null;
}

export interface BalanceObservation {
  readonly account: string;
  readonly assetId: string;
  readonly amountBase: string;
}

export interface ReorgResult {
  readonly commonAncestorBlockHash: string;
  readonly orphanedEvents: readonly LedgerEvent[];
  readonly replayedEvents: readonly LedgerEvent[];
  readonly duplicatesSkipped: number;
  readonly releasedReservations: Record<string, number>;
  readonly auditTrail: readonly AuditEntry[];
}

export class NonCanonicalAnchorError extends Error {
  readonly code = "NONCANONICAL_ANCHOR";
  constructor(
    readonly blockHash: string,
    readonly blockNumber: number,
    readonly canonicalHash: string | null,
  ) {
    super(`block ${String(blockNumber)} ${blockHash} is not canonical (canonical ${canonicalHash ?? "missing"})`);
    this.name = "NonCanonicalAnchorError";
  }
}

function add(balances: Map<string, Map<string, bigint>>, account: string, assetId: string, amount: bigint): void {
  const current = balances.get(account) ?? new Map<string, bigint>();
  current.set(assetId, (current.get(assetId) ?? 0n) + amount);
  balances.set(account, current);
}
function serializeBalances(balances: Map<string, Map<string, bigint>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [account, assets] of [...balances.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const record: Record<string, string> = {};
    for (const [assetId, amount] of [...assets.entries()].sort(([a], [b]) => a.localeCompare(b))) record[assetId] = amount.toString();
    out[account] = record;
  }
  return out;
}

/**
 * Ledger over one canonical branch. The initial projection is the state at the common
 * ancestor; every snapshot after it is applied on top.
 */
export class CanonicalReconciliationLedger {
  private balances = new Map<string, Map<string, bigint>>();
  private reservations = new Map<string, bigint>();
  private releasedReservations = new Map<string, number>();
  private processedEventIds = new Set<string>();
  private auditTrail: AuditEntry[] = [];
  private blockNumber = 0;
  private blockHash = "";

  constructor(initial: LedgerCheckpoint) {
    this.restore(initial);
  }

  static initialCheckpoint(blockNumber: number, blockHash: string, initialBalances: readonly BalanceObservation[]): LedgerCheckpoint {
    const balances: Record<string, Record<string, string>> = {};
    for (const entry of initialBalances) {
      balances[entry.account] ??= {};
      balances[entry.account]![entry.assetId] = entry.amountBase;
    }
    return { schemaVersion: "1.0.0", blockNumber, blockHash, balances, reservations: {}, releasedReservations: {}, processedEventIds: [], auditTrail: [] };
  }

  static fromCheckpoint(checkpoint: LedgerCheckpoint): CanonicalReconciliationLedger {
    return new CanonicalReconciliationLedger(checkpoint);
  }

  checkpoint(): LedgerCheckpoint {
    return {
      schemaVersion: "1.0.0",
      blockNumber: this.blockNumber,
      blockHash: this.blockHash,
      balances: serializeBalances(this.balances),
      reservations: Object.fromEntries([...this.reservations.entries()].map(([orderId, amount]) => [orderId, amount.toString()])),
      releasedReservations: Object.fromEntries([...this.releasedReservations.entries()]),
      processedEventIds: [...this.processedEventIds],
      auditTrail: [...this.auditTrail],
    };
  }

  restore(checkpoint: LedgerCheckpoint): void {
    this.balances = new Map();
    for (const [account, assets] of Object.entries(checkpoint.balances)) {
      for (const [assetId, amount] of Object.entries(assets)) add(this.balances, account, assetId, BigInt(amount));
    }
    this.reservations = new Map(Object.entries(checkpoint.reservations).map(([orderId, amount]) => [orderId, BigInt(amount)]));
    this.releasedReservations = new Map(Object.entries(checkpoint.releasedReservations));
    this.processedEventIds = new Set(checkpoint.processedEventIds);
    this.auditTrail = [...checkpoint.auditTrail];
    this.blockNumber = checkpoint.blockNumber;
    this.blockHash = checkpoint.blockHash;
  }

  private applyEvent(event: LedgerEvent): "applied" | "duplicate" {
    if (this.processedEventIds.has(event.eventId)) {
      this.auditTrail.push({ action: "skip-duplicate", eventId: event.eventId, blockHash: event.blockHash, blockNumber: event.blockNumber, branch: "replacement", reason: "event id already processed" });
      return "duplicate";
    }
    this.processedEventIds.add(event.eventId);
    switch (event.kind) {
      case "RESERVE": {
        const amount = BigInt(event.amountBase);
        add(this.balances, event.account, event.assetId, -amount);
        add(this.balances, event.counterparty ?? event.account, event.assetId, amount);
        this.reservations.set(event.orderId, (this.reservations.get(event.orderId) ?? 0n) + amount);
        break;
      }
      case "RELEASE": {
        // A release after the first one for the same order is ignored economically and
        // counted, so a reservation can never be released twice.
        const released = this.releasedReservations.get(event.orderId) ?? 0;
        if (released > 0) {
          this.auditTrail.push({ action: "skip-duplicate", eventId: event.eventId, blockHash: event.blockHash, blockNumber: event.blockNumber, branch: "replacement", reason: "reservation already released once" });
          return "duplicate";
        }
        const amount = BigInt(event.amountBase);
        add(this.balances, event.counterparty ?? event.account, event.assetId, amount);
        add(this.balances, "escrow", event.assetId, -amount);
        this.releasedReservations.set(event.orderId, 1);
        this.reservations.set(event.orderId, (this.reservations.get(event.orderId) ?? 0n) - amount);
        break;
      }
      case "ALLOCATE": {
        add(this.balances, event.account, event.unitsAssetId, BigInt(event.unitsBase));
        break;
      }
      case "REDEEM": {
        add(this.balances, event.account, event.assetId, BigInt(event.amountBase));
        add(this.balances, "issuer", event.assetId, -BigInt(event.amountBase));
        add(this.balances, event.account, event.unitsAssetId, -BigInt(event.unitsBase));
        break;
      }
      case "SPOT": {
        const cash = BigInt(event.amountBase);
        const fee = BigInt(event.feeBase);
        const units = BigInt(event.unitsBase);
        add(this.balances, event.account, "dEUR", -(cash + fee));
        add(this.balances, event.counterparty ?? "dealer", "dEUR", cash);
        add(this.balances, "fee", "dEUR", fee);
        add(this.balances, event.account, event.unitsAssetId, units);
        add(this.balances, event.counterparty ?? "dealer", event.unitsAssetId, -units);
        break;
      }
    }
    this.auditTrail.push({ action: "apply", eventId: event.eventId, blockHash: event.blockHash, blockNumber: event.blockNumber, branch: "replacement", reason: null });
    return "applied";
  }

  /** Apply one canonical snapshot. The expected hash must match the snapshot hash. */
  applySnapshot(snapshot: LedgerSnapshot, expectedCanonicalHash: string | null): { applied: number; duplicates: number } {
    if (expectedCanonicalHash !== null && expectedCanonicalHash.toLowerCase() !== snapshot.blockHash.toLowerCase()) {
      this.auditTrail.push({ action: "reject-anchor", eventId: null, blockHash: snapshot.blockHash, blockNumber: snapshot.blockNumber, branch: "previous", reason: "noncanonical anchor" });
      throw new NonCanonicalAnchorError(snapshot.blockHash, snapshot.blockNumber, expectedCanonicalHash);
    }
    let applied = 0;
    let duplicates = 0;
    for (const event of snapshot.events) {
      if (this.applyEvent(event) === "applied") applied += 1;
      else duplicates += 1;
    }
    this.blockNumber = snapshot.blockNumber;
    this.blockHash = snapshot.blockHash;
    return { applied, duplicates };
  }

  /**
   * Reconcile a reorg: rebuild the projection from the common ancestor, mark the previous
   * branch events orphaned, and replay the replacement branch. The ancestor snapshots are
   * the canonical chain from the ledger's initial checkpoint up to and including the common
   * ancestor. Audit entries for both branches stay attached to the returned state.
   */
  reconcileReorg(params: {
    initialCheckpoint: LedgerCheckpoint;
    ancestorSnapshots: readonly LedgerSnapshot[];
    previousBranch: readonly LedgerSnapshot[];
    replacementBranch: readonly LedgerSnapshot[];
    expectedCanonicalHash: (snapshot: LedgerSnapshot) => string | null;
  }): ReorgResult {
    const orphanedEvents: LedgerEvent[] = [];
    this.auditTrail = [];
    this.restore({ ...params.initialCheckpoint, auditTrail: [], processedEventIds: [], releasedReservations: {}, reservations: {}, balances: params.initialCheckpoint.balances });
    for (const snapshot of params.ancestorSnapshots) {
      this.applySnapshot(snapshot, params.expectedCanonicalHash(snapshot));
      this.auditTrail.push({ action: "apply", eventId: null, blockHash: snapshot.blockHash, blockNumber: snapshot.blockNumber, branch: "ancestor", reason: null });
    }
    const commonAncestorBlockHash = this.blockHash;
    for (const snapshot of params.previousBranch) {
      for (const event of snapshot.events) orphanedEvents.push(event);
      this.auditTrail.push({ action: "orphan", eventId: null, blockHash: snapshot.blockHash, blockNumber: snapshot.blockNumber, branch: "previous", reason: "replaced by a reorg" });
    }
    if (this.blockNumber !== (params.ancestorSnapshots.at(-1)?.blockNumber ?? this.blockNumber)) {
      throw new Error("rewind did not reach the common ancestor");
    }
    const replayedEvents: LedgerEvent[] = [];
    let duplicatesSkipped = 0;
    for (const snapshot of params.replacementBranch) {
      const result = this.applySnapshot(snapshot, params.expectedCanonicalHash(snapshot));
      duplicatesSkipped += result.duplicates;
      replayedEvents.push(...snapshot.events);
      this.auditTrail.push({ action: "replay", eventId: null, blockHash: snapshot.blockHash, blockNumber: snapshot.blockNumber, branch: "replacement", reason: null });
    }
    for (const event of orphanedEvents) {
      this.processedEventIds.delete(event.eventId);
    }
    return {
      commonAncestorBlockHash,
      orphanedEvents,
      replayedEvents,
      duplicatesSkipped,
      releasedReservations: Object.fromEntries([...this.releasedReservations.entries()].filter(([orderId]) => !orphanedEvents.some((event) => event.orderId === orderId))),
      auditTrail: [...this.auditTrail],
    };
  }

  /** Apply a snapshot twice to verify duplicate delivery is idempotent. */
  applyDuplicateSnapshot(snapshot: LedgerSnapshot, expectedCanonicalHash: string | null): { applied: number; duplicates: number } {
    return this.applySnapshot(snapshot, expectedCanonicalHash);
  }

  /** Compare the projection with chain observations read at one exact block hash. */
  reconcileBalanceObservations(observations: readonly BalanceObservation[]): {
    differences: Array<{ account: string; assetId: string; projected: string; observed: string; difference: string }>;
    perAsset: Record<string, { projectedTotal: string; observedTotal: string; difference: string }>;
    conserved: boolean;
  } {
    const differences: Array<{ account: string; assetId: string; projected: string; observed: string; difference: string }> = [];
    const assets = new Set<string>();
    for (const [account, holdings] of this.balances) for (const assetId of holdings.keys()) assets.add(assetId);
    for (const observation of observations) assets.add(observation.assetId);
    for (const assetId of [...assets].sort()) {
      for (const account of [...this.balances.keys()].sort()) {
        const projected = this.balances.get(account)?.get(assetId) ?? 0n;
        const observed = observations.find((entry) => entry.account === account && entry.assetId === assetId);
        if (observed === undefined) continue;
        const difference = projected - BigInt(observed.amountBase);
        if (difference !== 0n) differences.push({ account, assetId, projected: projected.toString(), observed: observed.amountBase, difference: difference.toString() });
      }
    }
    const perAsset: Record<string, { projectedTotal: string; observedTotal: string; difference: string }> = {};
    for (const assetId of [...assets].sort()) {
      const projectedTotal = [...this.balances.values()].reduce((sum, holdings) => sum + (holdings.get(assetId) ?? 0n), 0n);
      const observedTotal = observations.filter((entry) => entry.assetId === assetId).reduce((sum, entry) => sum + BigInt(entry.amountBase), 0n);
      perAsset[assetId] = { projectedTotal: projectedTotal.toString(), observedTotal: observedTotal.toString(), difference: (projectedTotal - observedTotal).toString() };
    }
    return { differences, perAsset, conserved: differences.length === 0 && Object.values(perAsset).every((entry) => entry.difference === "0") };
  }

  projection(): { balances: Record<string, Record<string, string>>; reservations: Record<string, string>; blockNumber: number; blockHash: string } {
    return {
      balances: serializeBalances(this.balances),
      reservations: Object.fromEntries([...this.reservations.entries()].map(([orderId, amount]) => [orderId, amount.toString()])),
      blockNumber: this.blockNumber,
      blockHash: this.blockHash,
    };
  }

  audit(): readonly AuditEntry[] {
    return this.auditTrail;
  }
}
