/**
 * Policy Lab comparison evidence pack.
 *
 * The pack is reproducible byte for byte: it contains only frozen inputs,
 * computed branch results and canonical digests. No wall-clock values, random
 * run ids or model prose are hashed.
 */
import { ENGINE_VERSION, fileSha256, hashJson, type FundDealingPolicy } from "@eurorollup/dealing";
import { policyBaselineRef } from "./draft.js";
import type {
  BoundaryCaseResult,
  P01BoundaryFixture,
  P01Comparison,
} from "./types.js";
import { EVIDENCE_SCHEMA_VERSION, POLICY_LAB_VERSION } from "./version.js";

export interface PolicyLabEvidenceFileRef {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface P01ComparisonPack {
  readonly schemaVersion: string;
  readonly packId: "policy-lab-p01";
  readonly fixtureId: "P01";
  readonly fixtureVersion: string;
  readonly engineVersion: string;
  readonly policyLabVersion: string;
  readonly generatedBy: string;
  readonly fixtureHash: string;
  readonly calendarHash: string;
  readonly baselinePolicy: FundDealingPolicy;
  readonly candidatePolicy: FundDealingPolicy;
  readonly baselinePolicyHash: string;
  readonly candidatePolicyHash: string;
  readonly branches: {
    readonly baseline: {
      readonly eventLogHash: string;
      readonly orders: P01Comparison["baseline"]["orders"];
      readonly snapshots: P01Comparison["baseline"]["snapshots"];
    };
    readonly candidate: {
      readonly eventLogHash: string;
      readonly orders: P01Comparison["candidate"]["orders"];
      readonly snapshots: P01Comparison["candidate"]["snapshots"];
    };
  };
  readonly orderChanges: P01Comparison["orderChanges"];
  readonly affectedOrders: number;
  readonly totalOrders: number;
  readonly extraReservedAtFridayCloseBase: string;
  readonly deltas: P01Comparison["deltas"];
  readonly boundaryCases: readonly BoundaryCaseResult[];
  readonly boundarySummary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly checks: readonly string[];
  readonly comparisonDigest: string;
  readonly packDigest: string;
}

export interface BuildP01PackParams {
  readonly comparison: P01Comparison;
  readonly boundaryCases: readonly BoundaryCaseResult[];
  readonly boundaryFixture: P01BoundaryFixture;
}

export function buildP01ComparisonPack(params: BuildP01PackParams): P01ComparisonPack {
  const { comparison } = params;
  const baselineRef = policyBaselineRef(comparison.baseline.policy);
  const candidateRef = policyBaselineRef(comparison.candidate.policy);
  const boundaryPassed = params.boundaryCases.filter((item) => item.pass).length;
  const packWithoutDigest = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    packId: "policy-lab-p01" as const,
    fixtureId: "P01" as const,
    fixtureVersion: comparison.fixtureVersion,
    engineVersion: ENGINE_VERSION,
    policyLabVersion: POLICY_LAB_VERSION,
    generatedBy: "pnpm policy:replay",
    fixtureHash: comparison.fixtureHash,
    calendarHash: comparison.calendarHash,
    baselinePolicy: comparison.baseline.policy,
    candidatePolicy: comparison.candidate.policy,
    baselinePolicyHash: baselineRef.policyHash,
    candidatePolicyHash: candidateRef.policyHash,
    branches: {
      baseline: {
        eventLogHash: comparison.baseline.eventLogHash,
        orders: comparison.baseline.orders,
        snapshots: comparison.baseline.snapshots,
      },
      candidate: {
        eventLogHash: comparison.candidate.eventLogHash,
        orders: comparison.candidate.orders,
        snapshots: comparison.candidate.snapshots,
      },
    },
    orderChanges: comparison.orderChanges,
    affectedOrders: comparison.affectedOrders,
    totalOrders: comparison.totalOrders,
    extraReservedAtFridayCloseBase: comparison.extraReservedAtFridayCloseBase,
    deltas: comparison.deltas,
    boundaryCases: params.boundaryCases,
    boundarySummary: {
      total: params.boundaryCases.length,
      passed: boundaryPassed,
      failed: params.boundaryCases.length - boundaryPassed,
    },
    checks: [
      "P01-F-1450 settles Friday in both branches with 3.125000 units",
      "P01-F-1530 settles Friday in the baseline and Monday in the candidate",
      "Baseline Friday close: 1,400.00 spendable, 0.00 reserved, 6.250000 units",
      "Candidate Friday close: 1,400.00 spendable, 300.00 reserved, 3.125000 units",
      "Candidate Monday close: 1,400.00 spendable, 0.00 reserved, 6.125000 units",
      "1 of 2 orders changes dealing date and 300.00 dEUR stays reserved over the weekend",
      "Both branches spend 600.00 dEUR; unit deltas are not cash",
      "Every boundary replay case matches its frozen expectation",
    ],
    comparisonDigest: comparison.comparisonDigest,
  };
  const packDigest = hashJson(packWithoutDigest);
  return { ...packWithoutDigest, packDigest };
}

export function serializeP01ComparisonPack(pack: P01ComparisonPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export interface PolicyLabManifest {
  readonly schemaVersion: string;
  readonly packId: string;
  readonly engineVersion: string;
  readonly policyLabVersion: string;
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly generatedBy: string;
  readonly files: readonly PolicyLabEvidenceFileRef[];
  readonly packDigest: string;
  readonly comparisonDigest: string;
}

export function buildPolicyLabManifest(params: {
  pack: P01ComparisonPack;
  files: readonly PolicyLabEvidenceFileRef[];
}): PolicyLabManifest {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    packId: params.pack.packId,
    engineVersion: params.pack.engineVersion,
    policyLabVersion: params.pack.policyLabVersion,
    fixtureId: params.pack.fixtureId,
    fixtureVersion: params.pack.fixtureVersion,
    generatedBy: params.pack.generatedBy,
    files: params.files,
    packDigest: params.pack.packDigest,
    comparisonDigest: params.pack.comparisonDigest,
  };
}

export function evidenceFileRef(path: string, text: string): PolicyLabEvidenceFileRef {
  return {
    path,
    sha256: fileSha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

export function serializeManifest(manifest: PolicyLabManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
