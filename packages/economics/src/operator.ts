/**
 * Chain operator economics: fee-vault inflows versus batcher L1 outflows over the
 * same window. Each flow is counted once; duplicate flow identifiers are flagged
 * instead of being silently added twice. Infrastructure spend is reported
 * separately from protocol flows.
 */
import type { Wei } from "./types.js";

export interface OperatorFlowWindow {
  readonly windowStartBlock: number;
  readonly windowEndBlock: number;
  readonly feeVaultInflowWei: Wei;
  readonly batcherOutflowWei: Wei;
  readonly infrastructureSpendWei: Wei;
  readonly batcherTxHashes: readonly string[];
  /** Optional already-known flow identifiers used to detect accidental double counting. */
  readonly duplicateFlowIds?: readonly string[];
}

export interface OperatorEconomics {
  readonly window: { readonly startBlock: number; readonly endBlock: number };
  readonly feeVaultInflowWei: Wei;
  readonly batcherOutflowWei: Wei;
  readonly infrastructureSpendWei: Wei;
  readonly netProtocolWei: Wei;
  readonly netAfterInfrastructureWei: Wei;
  readonly countedFlows: readonly string[];
  readonly duplicateFlowsDetected: boolean;
  readonly notes: readonly string[];
}

export function reconcileOperatorEconomics(input: OperatorFlowWindow): OperatorEconomics {
  if (input.windowEndBlock < input.windowStartBlock) {
    throw new Error("operator window end block must not precede the start block");
  }
  const batcherTxHashes = input.batcherTxHashes.map((hash) => hash.toLowerCase());
  const duplicateTxHashes = batcherTxHashes.filter((hash, index) => batcherTxHashes.indexOf(hash) !== index);
  const duplicateFlowIds = (input.duplicateFlowIds ?? []).map((id) => id.toLowerCase());
  const duplicateFlowsDetected = duplicateTxHashes.length > 0 || duplicateFlowIds.length !== new Set(duplicateFlowIds).size;

  const netProtocolWei = input.feeVaultInflowWei - input.batcherOutflowWei;
  const notes = [
    "L2 user data fees are fee-vault inflows; the batcher's L1 purchase (blob or calldata) is an L1 outflow. They are separate flows and are counted once.",
    "Infrastructure spend is reported separately and is not netted against protocol flows.",
  ];
  if (duplicateFlowsDetected) {
    notes.push("duplicate flow identifiers were detected; resolve them before treating the net as final.");
  }

  return {
    window: { startBlock: input.windowStartBlock, endBlock: input.windowEndBlock },
    feeVaultInflowWei: input.feeVaultInflowWei,
    batcherOutflowWei: input.batcherOutflowWei,
    infrastructureSpendWei: input.infrastructureSpendWei,
    netProtocolWei,
    netAfterInfrastructureWei: netProtocolWei - input.infrastructureSpendWei,
    countedFlows: ["fee-vault-inflow", "batcher-l1-outflow"],
    duplicateFlowsDetected,
    notes,
  };
}
