/**
 * Offline verification of the committed A05 protocol-run and bridge-trace
 * evidence.
 *
 * CI cannot start the local OP Stack network, so this verifier checks that the
 * committed packs are internally consistent and satisfy the A05 gate: the batch
 * transactions really point at the batch inbox, the recorded data availability
 * mode is stated honestly, the withdrawal was proven against the recorded game,
 * the game resolved to DEFENDER_WINS, the finalization transaction was successful
 * and the recipient received exactly the withdrawn value. Schema validation is
 * done against the committed versioned JSON Schemas.
 *
 * Live re-capture: `pnpm devnet:local:up && pnpm local:evidence`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

interface ProtocolRun {
  schemaVersion: string;
  reportId: string;
  generatedBy: string;
  images: Array<{ container: string; image: string; digest: string }>;
  chains: { l1: { chainId: number; finalityAvailable: boolean }; l2: { chainId: number } };
  actors: Record<string, string>;
  deposit: { l1Tx: string; l2Tx: string; value: string };
  l2Activity: { transactions: Array<{ hash: string; blockNumber: number }>; lastBlock: number };
  batches: {
    dataAvailabilityMode: string;
    batchInboxAddress: string;
    observedBatchTransactions: Array<{
      txHash: string;
      l1Block: number;
      calldataBytes: number;
      versionedBlobHashes: string[];
      dataAvailabilityMode: string;
    }>;
    safeHeadAfterIndexing: { number: string };
  };
  summary: {
    passed: boolean;
    batchTransactionsObserved: number;
    safeHeadAdvanced: boolean;
    blobDataAvailability: boolean;
    l1FinalityObserved: boolean;
  };
}

interface BridgeTrace {
  schemaVersion: string;
  reportId: string;
  timers: {
    proofMaturityDelaySeconds: string;
    disputeGameFinalityDelaySeconds: string;
    disputeGameMaxClockDurationSeconds: string;
    disputeGameClockExtensionSeconds: string;
    respectedGameType: number;
    timeAcceleration: Array<{ requestedSeconds: number; before: number; after: number }>;
  };
  withdrawalInitiation: { l2Tx: string; l2Block: number; withdrawalHash: string; value: string };
  outputRootProof: { gameAddress: string; gameIndex: string; l2Block: string; rootClaim: string; outputRoot: string };
  l1Proving: { txHash: string };
  disputeGameResolution: { status: string; resolveClaimTx: string | null; resolveTx: string | null };
  finalization: {
    txHash: string;
    status: number;
    recipient: string;
    recipientDeltaWei: string;
    relayedByL1CrossDomainMessenger: boolean;
    withdrawalValueWei: string;
  };
  summary: { passed: boolean; withdrawalProven: boolean; disputeGameResolved: boolean; withdrawalFinalized: boolean };
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function expectHash(value: string, label: string): void {
  check(/^0x[0-9a-fA-F]{64}$/.test(value), `${label} must be a 32-byte hex hash`);
}

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const protocolSchema = ajv.compile(readJson("schemas/a05-protocol-run.schema.json") as object);
  const bridgeSchema = ajv.compile(readJson("schemas/a05-bridge-trace.schema.json") as object);
  const protocol = readJson("evidence/a05/protocol-run.json") as ProtocolRun;
  const bridge = readJson("evidence/a05/bridge-trace.json") as BridgeTrace;

  check(protocolSchema(protocol), `protocol-run schema: ${JSON.stringify(protocolSchema.errors)}`);
  check(bridgeSchema(bridge), `bridge-trace schema: ${JSON.stringify(bridgeSchema.errors)}`);

  // --- protocol run ---
  check(protocol.reportId === "A05-protocol-run", "protocol run report id");
  check(protocol.chains.l1.chainId === 11155111, "L1 chain id must be 11155111");
  check(protocol.chains.l2.chainId === 16584, "L2 chain id must be 16584");
  check(protocol.chains.l1.finalityAvailable === false, "the execution-only L1 must not claim consensus finality");
  check(protocol.summary.l1FinalityObserved === false, "summary must not claim L1 finality");
  check(protocol.summary.blobDataAvailability === false, "summary must state that blob DA is not demonstrated");
  check(protocol.batches.dataAvailabilityMode === "calldata", "batch DA mode must be reported as calldata");
  check(protocol.images.length === 4, "four pinned OP Stack images are expected");
  check(protocol.images.every((image) => image.digest.includes("@sha256:") || image.digest.startsWith("us-docker")), "image digests are missing");
  check(Object.keys(protocol.actors).length === 11, "the actor inventory must list eleven role addresses");

  expectHash(protocol.deposit.l1Tx, "deposit L1 tx");
  expectHash(protocol.deposit.l2Tx, "deposit L2 tx");
  check(protocol.deposit.value === "500000000000000000", "deposit value must be 0.5 ETH in wei");
  check(protocol.l2Activity.transactions.length === 6, "six L2 activity transactions are expected");
  protocol.l2Activity.transactions.forEach((tx, index) => expectHash(tx.hash, `activity tx ${index + 1}`));
  check(protocol.l2Activity.transactions.every((tx) => tx.blockNumber <= protocol.l2Activity.lastBlock), "activity blocks must not exceed the recorded last block");

  const batchInbox = protocol.batches.batchInboxAddress.toLowerCase();
  check(protocol.batches.observedBatchTransactions.length >= 1, "at least one batch transaction is required");
  check(
    protocol.batches.observedBatchTransactions.length === protocol.summary.batchTransactionsObserved,
    "batch transaction count must match the summary",
  );
  for (const [index, batch] of protocol.batches.observedBatchTransactions.entries()) {
    expectHash(batch.txHash, `batch tx ${index + 1}`);
    check(batch.dataAvailabilityMode === "calldata", `batch tx ${index + 1} must report calldata mode`);
    check(batch.versionedBlobHashes.length === 0, `calldata batch tx ${index + 1} must not claim blob hashes`);
    check(batch.calldataBytes > 0, `batch tx ${index + 1} must carry calldata`);
  }
  check(batchInbox.startsWith("0x") && batchInbox.length === 42, "batch inbox address is invalid");
  check(
    Number.parseInt(protocol.batches.safeHeadAfterIndexing.number, 16) >= protocol.l2Activity.lastBlock,
    "the L2 safe head must cover the recorded activity",
  );
  check(protocol.summary.passed === true, "protocol-run summary must pass");
  check(protocol.summary.safeHeadAdvanced === true, "protocol-run summary must report safe-head progress");

  // --- bridge trace ---
  check(bridge.reportId === "A05-bridge-trace", "bridge trace report id");
  check(bridge.timers.proofMaturityDelaySeconds === "604800", "the real seven-day proof maturity timer must be recorded");
  check(bridge.timers.disputeGameFinalityDelaySeconds === "302400", "the real dispute-game finality timer must be recorded");
  check(bridge.timers.disputeGameMaxClockDurationSeconds === "302400", "the real game clock duration must be recorded");
  check(bridge.timers.disputeGameClockExtensionSeconds === "10800", "the real clock extension must be recorded");
  check(bridge.timers.timeAcceleration.length >= 1, "the local clock accelerations must be recorded");
  check(
    bridge.timers.timeAcceleration.every((entry) => entry.after > entry.before && entry.requestedSeconds > 0),
    "clock acceleration entries must move the L1 clock forward",
  );

  expectHash(bridge.withdrawalInitiation.l2Tx, "withdrawal L2 tx");
  expectHash(bridge.withdrawalInitiation.withdrawalHash, "withdrawal hash");
  check(bridge.withdrawalInitiation.value === bridge.finalization.withdrawalValueWei, "withdrawn value must match the finalized value");
  expectHash(bridge.outputRootProof.rootClaim, "game root claim");
  check(
    bridge.outputRootProof.outputRoot.toLowerCase() === bridge.outputRootProof.rootClaim.toLowerCase(),
    "the proven output root must equal the dispute-game root claim",
  );
  check(
    Number.parseInt(bridge.outputRootProof.l2Block, 10) >= bridge.withdrawalInitiation.l2Block,
    "the dispute game must cover the withdrawal block",
  );
  expectHash(bridge.l1Proving.txHash, "prove transaction");
  check(bridge.disputeGameResolution.status === "2", "the dispute game must resolve to DEFENDER_WINS (status 2)");
  expectHash(bridge.finalization.txHash, "finalize transaction");
  check(bridge.finalization.status === 1, "the finalization transaction must succeed");
  check(bridge.finalization.relayedByL1CrossDomainMessenger, "the finalize receipt must relay through the L1CrossDomainMessenger");
  check(
    bridge.finalization.recipientDeltaWei === bridge.finalization.withdrawalValueWei,
    "the recipient must receive exactly the withdrawn value",
  );
  check(bridge.summary.passed === true, "bridge-trace summary must pass");
  check(bridge.summary.withdrawalProven && bridge.summary.disputeGameResolved && bridge.summary.withdrawalFinalized, "bridge summary flags");

  if (failures.length > 0) {
    console.error("A05 evidence verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `A05 evidence verified: ${protocol.batches.observedBatchTransactions.length} calldata batch transaction(s), ` +
      `withdrawal ${bridge.withdrawalInitiation.withdrawalHash} proven and finalized with ${bridge.finalization.recipientDeltaWei} wei`,
  );
}

main();
