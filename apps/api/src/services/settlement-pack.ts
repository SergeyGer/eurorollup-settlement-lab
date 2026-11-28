/**
 * Settlement pack export for investment runs.
 *
 * A run is the settlement trace of one accepted order (`runId == orderId`). The pack keeps
 * the business state and the observed chain status in separate objects, joins the order id
 * to an independently produced chain witness when one is attached, lists journal entries
 * and time-stamped cost inputs, and records unknown values as `null` with a reason. The
 * manifest carries canonical SHA-256 digests of every section so a verifier can detect a
 * changed amount or block hash.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ENGINE_VERSION, canonicalJson, hashJson } from "@eurorollup/dealing";
import type { MoneyMovement, Order, OrderReceipt, Portfolio } from "@eurorollup/sdk";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db.js";
import { getNavRow, getOrderRow, getQuoteRow } from "../repository.js";
import type { OrderService } from "./orders.js";
import type { PortfolioService } from "./portfolio.js";
import { problem } from "../problems.js";

export const SETTLEMENT_PACK_SCHEMA_VERSION = "1.0.0";
export const SETTLEMENT_PACK_ID = "SETTLEMENT-PACK";

/** Independently produced chain witness artifact attached by the settlement runner. */
export interface ChainWitness {
  readonly orderId: string;
  readonly chainId: number;
  readonly orderIdBytes32: string;
  readonly userOpHash: string | null;
  readonly txHash: string;
  readonly logIndex: number;
  readonly l2BlockHash: string;
  readonly l2BlockNumber: number;
  readonly canonicalBlockNumber: number;
  readonly canonicalBlockHash: string;
  readonly l1BatchReference: string | null;
  readonly policyHash: string;
  readonly observedAt: string;
  readonly receiptStatus: number;
  readonly contracts: Record<string, string>;
  readonly observations: Array<{
    readonly account: string;
    readonly role: string;
    readonly assetId: string;
    readonly amountBase: string;
  }>;
  readonly unknowns?: Array<{ readonly field: string; readonly reason: string }>;
}

interface ChainWitnessFile {
  readonly schemaVersion: string;
  readonly witnesses: ChainWitness[];
}

export interface SettlementPack {
  readonly schemaVersion: string;
  readonly packId: string;
  readonly runId: string;
  readonly orderId: string;
  readonly generatedAt: string;
  readonly environment: {
    readonly dataMode: string;
    readonly serviceVersion: string;
    readonly engineVersion: string;
    readonly policyId: string;
    readonly policyVersion: number;
    readonly policyHash: string;
  };
  readonly manifest: {
    readonly algorithm: "sha256-canonical-json";
    readonly packDigest: string;
    readonly sections: Record<string, string>;
    readonly externalArtifacts: Array<{ readonly name: string; readonly sha256: string }>;
  };
  readonly order: Record<string, unknown>;
  readonly business: {
    readonly businessState: string;
    readonly chainStateField: string;
    readonly receipt: OrderReceipt | null;
    readonly decline: Record<string, unknown> | null;
    readonly reasonCode: string | null;
    readonly journalEntries: readonly MoneyMovement[];
    readonly portfolio: Portfolio;
    readonly journalBalances: readonly { account: string; accountKind: string; assetId: string; amountBase: string }[];
  };
  readonly costs: Array<{
    readonly name: string;
    readonly value: string;
    readonly assetId: string | null;
    readonly asOf: string;
    readonly source: string;
    readonly policyVersion: number;
  }>;
  readonly chain: {
    readonly status: "OBSERVED" | "NOT_ATTACHED";
    readonly orderIdBytes32: string | null;
    readonly userOpHash: string | null;
    readonly txHash: string | null;
    readonly logIndex: number | null;
    readonly l2BlockHash: string | null;
    readonly l2BlockNumber: number | null;
    readonly canonicalBlockNumber: number | null;
    readonly canonicalBlockHash: string | null;
    readonly l1BatchReference: string | null;
    readonly policyHash: string;
    readonly observedAt: string | null;
    readonly receiptStatus: number | null;
    readonly contracts: Record<string, string>;
    readonly observations: readonly {
      readonly account: string;
      readonly role: string;
      readonly assetId: string;
      readonly amountBase: string;
    }[];
    readonly witnessSha256: string | null;
    readonly unknowns: ReadonlyArray<{ readonly field: string; readonly reason: string }>;
  };
  readonly unknowns: ReadonlyArray<{ readonly field: string; readonly reason: string }>;
}

function readWitnessFile(path: string | null): { file: ChainWitnessFile | null; sha256: string | null; error: string | null } {
  if (path === null || !existsSync(path)) {
    return { file: null, sha256: null, error: path === null ? "CHAIN_WITNESS_PATH is not configured for this API instance" : "chain witness file is not present yet" };
  }
  try {
    const bytes = readFileSync(path);
    const file = JSON.parse(bytes.toString("utf8")) as ChainWitnessFile;
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  } catch (error) {
    return { file: null, sha256: null, error: `chain witness file could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function journalBalances(order: Order): SettlementPack["business"]["journalBalances"] {
  const totals = new Map<string, { account: string; accountKind: string; assetId: string; amountBase: bigint }>();
  for (const entry of order.moneyMovements) {
    for (const posting of entry.postings) {
      const key = `${posting.accountKind}|${posting.accountId}|${posting.assetId}`;
      const current = totals.get(key) ?? { account: posting.accountId, accountKind: posting.accountKind, assetId: posting.assetId, amountBase: 0n };
      current.amountBase += BigInt(posting.amountBase);
      totals.set(key, current);
    }
  }
  return [...totals.values()].map((item) => ({ ...item, amountBase: item.amountBase.toString() }));
}

export class SettlementPackService {
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly orders: OrderService,
    private readonly portfolio: PortfolioService,
  ) {}

  getRunEvidence(runId: string): { fileName: string; json: string; pack: SettlementPack } {
    const orderRow = getOrderRow(this.db, runId);
    if (orderRow === null) {
      throw problem(404, "ORDER_NOT_FOUND", `Unknown investment run ${runId}`, { runId });
    }
    const order = this.orders.getOrder(runId);
    const quoteRow = getQuoteRow(this.db, order.quoteId);
    const generatedAt = this.clockNow();
    const witnessRead = readWitnessFile(this.config.chainWitnessPath);
    const witness = witnessRead.file?.witnesses.find((entry) => entry.orderId === runId) ?? null;
    const policyHash = order.policyEpoch;

    const unknowns: Array<{ field: string; reason: string }> = [];
    const unknown = (field: string, value: unknown, reason: string): void => {
      if (value === null || value === undefined) unknowns.push({ field, reason });
    };
    const costs: SettlementPack["costs"] = [];
    if (quoteRow !== null) {
      if (quoteRow.price_base !== null) {
        costs.push({ name: "dealer-spot-price", value: quoteRow.price_base, assetId: "tWETH", asOf: quoteRow.price_as_of ?? quoteRow.created_at, source: "dealer fixture price source", policyVersion: this.config.policy.version });
      }
      if (quoteRow.indicative_nav_base !== null) {
        costs.push({ name: "indicative-nav", value: quoteRow.indicative_nav_base, assetId: "eFUND", asOf: quoteRow.created_at, source: "issuer indicative NAV", policyVersion: this.config.policy.version });
      }
      costs.push({ name: "charge-ceiling", value: quoteRow.charge_ceiling_base, assetId: "dEUR", asOf: quoteRow.created_at, source: "dealing policy charge ceiling", policyVersion: this.config.policy.version });
    }
    for (const nav of
      order.dealingTerms === null
        ? []
        : [getNavRow(this.db, "eFUND", order.dealingTerms.assignedDealingDate)].filter((row) => row !== null)) {
      costs.push({ name: `authorized-nav-${nav.valuation_date}`, value: nav.nav_base, assetId: "eFUND", asOf: nav.observed_at, source: `issuer NAV revision ${String(nav.revision)} by ${nav.signer}`, policyVersion: this.config.policy.version });
    }
    const chainState: "OBSERVED" | "NOT_ATTACHED" = witness === null ? "NOT_ATTACHED" : "OBSERVED";
    unknown("chain.userOpHash", witness?.userOpHash ?? null, witness === null ? "no chain witness is attached to this run" : "the attached witness was produced on the operator settlement lane, which has no ERC-4337 user operation");
    unknown("chain.canonicalBlockNumber", witness?.canonicalBlockNumber ?? null, witness === null ? "no chain witness is attached to this run" : "the chain witness omitted the canonical block number");
    unknown("chain.orderIdBytes32", witness?.orderIdBytes32 ?? null, witness === null ? "the onchain order id projection is computed by the chain witness producer" : "the chain witness omitted the onchain order id projection");
    unknown("chain.l1BatchReference", witness?.l1BatchReference ?? null, witness === null ? "no chain witness is attached to this run" : "the calldata development lane has no recorded L1 batch reference for this transaction");
    const chainUnknowns = [...new Map([...unknowns.filter((entry) => entry.field.startsWith("chain.")), ...(witness?.unknowns ?? [])].map((entry) => [entry.field, entry])).values()];
    const observations = witness?.observations ?? [];
    const core = {
      schemaVersion: SETTLEMENT_PACK_SCHEMA_VERSION,
      packId: SETTLEMENT_PACK_ID,
      runId,
      orderId: order.orderId,
      environment: {
        dataMode: this.config.dataMode,
        serviceVersion: this.config.serviceVersion,
        engineVersion: ENGINE_VERSION,
        policyId: this.config.policy.policyId,
        policyVersion: this.config.policy.version,
        policyHash,
      },
      order: {
        orderId: order.orderId,
        quoteId: order.quoteId,
        accountId: order.accountId,
        kind: order.kind,
        assetId: order.assetId,
        side: order.side,
        amountBase: order.amountBase,
        businessState: order.businessState,
        chainState: order.chainState,
        reasonCode: order.reasonCode,
        traceId: order.traceId,
        policyEpoch: order.policyEpoch,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        dealingTerms: order.dealingTerms,
      },
      business: {
        businessState: order.businessState,
        chainStateField: order.chainState,
        receipt: order.receipt,
        decline: order.decline,
        reasonCode: order.reasonCode,
        journalEntries: order.moneyMovements,
        portfolio: this.portfolio.getPortfolio(order.accountId),
        journalBalances: journalBalances(order),
      },
      costs,
      chain: {
        status: chainState,
        orderIdBytes32: witness?.orderIdBytes32 ?? null,
        userOpHash: witness?.userOpHash ?? null,
        txHash: witness?.txHash ?? null,
        logIndex: witness?.logIndex ?? null,
        l2BlockHash: witness?.l2BlockHash ?? null,
        l2BlockNumber: witness?.l2BlockNumber ?? null,
        canonicalBlockNumber: witness?.canonicalBlockNumber ?? null,
        canonicalBlockHash: witness?.canonicalBlockHash ?? null,
        l1BatchReference: witness?.l1BatchReference ?? null,
        policyHash,
        observedAt: witness?.observedAt ?? null,
        receiptStatus: witness?.receiptStatus ?? null,
        contracts: witness?.contracts ?? {},
        observations,
        witnessSha256: witnessRead.sha256,
        unknowns: chainUnknowns,
      },
      unknowns: [...chainUnknowns, ...unknowns.filter((entry) => !entry.field.startsWith("chain."))],
    };
    const sections = {
      order: hashJson(core.order),
      business: hashJson(core.business),
      costs: hashJson(core.costs),
      chain: hashJson(core.chain),
      environment: hashJson(core.environment),
    };
    const pack: SettlementPack = {
      ...core,
      generatedAt,
      manifest: {
        algorithm: "sha256-canonical-json",
        packDigest: hashJson({ order: core.order, business: core.business, costs: core.costs, chain: core.chain, environment: core.environment }),
        sections,
        externalArtifacts: witnessRead.sha256 === null ? [] : [{ name: "chain-witness", sha256: witnessRead.sha256 }],
      },
    };
    return {
      fileName: `settlement-pack-${runId}.json`,
      json: `${JSON.stringify(pack, null, 2)}\n`,
      pack,
    };
  }

  private clockNow(): string {
    const row = this.db.prepare("SELECT now FROM clock WHERE id = 1").get() as { now: string } | undefined;
    return row?.now ?? this.config.fixtureClockStart;
  }
}

export function canonicalPackJson(pack: SettlementPack): string {
  return canonicalJson(pack);
}
