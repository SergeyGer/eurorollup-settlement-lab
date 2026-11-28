/**
 * A05 protocol-run and bridge-trace evidence capture.
 *
 * Runs against the controlled local OP Stack devnet started by
 * `devnet/local/up.sh` (anvil L1 + op-reth + op-node + op-batcher + op-proposer).
 *
 * The capture performs real operations: an L1 -> L2 deposit, L2 activity that is
 * batched to L1, one L2 -> L1 ETH withdrawal, the output-root proof, dispute-game
 * resolution and `finalizeWithdrawalTransaction` on the portal. The production
 * portal timers are satisfied by advancing the private anvil clock; every time
 * acceleration is recorded next to the observed timestamps.
 *
 * Outputs:
 *   evidence/a05/protocol-run.json
 *   evidence/a05/bridge-trace.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  hexlify,
  keccak256,
  toUtf8Bytes,
  type TransactionReceipt,
} from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runDir = process.env.DEVNET_LOCAL_RUN_DIR ?? join(repoRoot, ".devnet-local", "run");
const evidenceDir = join(repoRoot, "evidence", "a05");

const L2_STANDARD_BRIDGE = "0x4200000000000000000000000000000000000010";
const L2_TO_L1_MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";
const BATCH_INBOX = "0x0098faa3fd68e74587cfad4029165ae7a85a73b5";
const GAS_LIMIT_WEI = 21_000n;

interface DevnetEnv {
  readonly workDir: string;
  readonly l1Rpc: string;
  readonly l2Rpc: string;
  readonly nodeRpc: string;
  readonly portal: string;
  readonly disputeGameFactory: string;
  readonly gameType: number;
  readonly contracts: Readonly<Record<string, string>>;
  readonly keys: Readonly<Record<string, string>>;
  readonly addresses: Readonly<Record<string, string>>;
}

const env = JSON.parse(readFileSync(join(runDir, "env.json"), "utf8")) as DevnetEnv;
const rollup = JSON.parse(readFileSync(join(runDir, "rollup.json"), "utf8")) as Record<string, unknown>;

const l1 = new JsonRpcProvider(env.l1Rpc, undefined, { staticNetwork: true });
const l2 = new JsonRpcProvider(env.l2Rpc, undefined, { staticNetwork: true });

const l1Wallet = new Wallet(env.keys["deployer"]!, l1);
const l2Wallet = new Wallet(env.keys["deployer"]!, l2);

const portalAbi = [
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
  "function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _disputeGameIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] _withdrawalProof)",
  "function finalizeWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx)",
  "function proofMaturityDelaySeconds() view returns (uint256)",
  "function disputeGameFinalityDelaySeconds() view returns (uint256)",
  "function respectedGameType() view returns (uint32)",
  "function provenWithdrawals(bytes32, address) view returns (address disputeGameProxy, uint64 timestamp)",
];
const portal = new Contract(env.portal, portalAbi, l1Wallet);
const portalRead = new Contract(env.portal, portalAbi, l1);
const factory = new Contract(
  env.disputeGameFactory,
  ["function gameCount() view returns (uint256)", "function gameAtIndex(uint256) view returns (uint32 gameType, uint64 timestamp, address proxy)"],
  l1,
);
const gameAbi = [
  "function rootClaim() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function status() view returns (uint8)",
  "function createdAt() view returns (uint64)",
  "function resolvedAt() view returns (uint64)",
  "function maxClockDuration() view returns (uint64)",
  "function clockExtension() view returns (uint64)",
  "function resolveClaim(uint256 _claimIndex, uint256 _numToResolve)",
  "function resolve()",
];
const bridge = new Contract(L2_STANDARD_BRIDGE, ["function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable"], l2Wallet);
const messagePasserIface = new Interface([
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
]);

interface BlockRef {
  readonly number: number;
  readonly hash: string;
  readonly timestamp: number;
  readonly parentHash: string;
}

async function nodeCall<T>(method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(env.nodeRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`op-node RPC ${method} failed with HTTP ${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: { message: string } };
  if (payload.error !== undefined) throw new Error(`op-node RPC ${method} failed: ${payload.error.message}`);
  if (payload.result === undefined) throw new Error(`op-node RPC ${method} returned no result`);
  return payload.result;
}

async function blockRef(provider: JsonRpcProvider, tag: string): Promise<BlockRef | null> {
  const block = (await provider.send("eth_getBlockByNumber", [tag, false])) as Record<string, unknown> | null;
  if (block === null) return null;
  return {
    number: Number.parseInt(String(block["number"]), 16),
    hash: String(block["hash"]),
    timestamp: Number.parseInt(String(block["timestamp"]), 16),
    parentHash: String(block["parentHash"]),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerJson(args: readonly string[]): unknown {
  return JSON.parse(execFileSync("docker", args, { encoding: "utf8" }).trim());
}

function containerImages(): Array<{ container: string; image: string; digest: string }> {
  const output: Array<{ container: string; image: string; digest: string }> = [];
  for (const container of ["op-reth-local", "op-node-local", "op-batcher-local", "op-proposer-local"]) {
    try {
      const image = execFileSync("docker", ["inspect", "--format", "{{.Config.Image}}", container], { encoding: "utf8" }).trim();
      const digests = dockerJson(["image", "inspect", "--format", "{{json .RepoDigests}}", image]) as string[];
      output.push({ container, image, digest: digests[0] ?? `local:${image}` });
    } catch {
      output.push({ container, image: "missing", digest: "missing" });
    }
  }
  return output;
}

async function syncStatus(): Promise<Record<string, Record<string, unknown>>> {
  return await nodeCall<Record<string, Record<string, unknown>>>("optimism_syncStatus", []);
}

/** op-node versions return sync-status numbers either as JSON numbers or as hex strings. */
function parseNodeQuantity(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function headNumber(status: Record<string, Record<string, unknown>>, key: string): number {
  const head = status[key];
  return head === undefined ? 0 : parseNodeQuantity(head["number"]);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitL2Balance(minimum: bigint): Promise<bigint> {
  let balance = 0n;
  await waitFor(
    async () => {
      balance = await l2.getBalance(l2Wallet.address);
      return balance >= minimum;
    },
    600_000,
    "L2 deposit derivation",
  );
  return balance;
}

async function firstL2DepositBlock(fromBlock: number, recipient: string): Promise<{ blockNumber: number; hash: string; value: bigint } | null> {
  const head = Number.parseInt(String(await l2.send("eth_blockNumber", [])), 16);
  for (let number = fromBlock; number <= head; number += 1) {
    const block = (await l2.send("eth_getBlockByNumber", [`0x${number.toString(16)}`, true])) as Record<string, unknown> | null;
    for (const tx of (block?.["transactions"] as Array<Record<string, unknown>>) ?? []) {
      if (tx["type"] === "0x7e" && String(tx["to"]).toLowerCase() === recipient.toLowerCase()) {
        return { blockNumber: number, hash: String(tx["hash"]), value: BigInt(String(tx["value"])) };
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  console.log(`capturing A05 evidence from ${env.l1Rpc} / ${env.l2Rpc} / ${env.nodeRpc}`);

  const generatedAt = new Date().toISOString();
  const l1ChainId = Number.parseInt(String(await l1.send("eth_chainId", [])), 16);
  const l2ChainId = Number.parseInt(String(await l2.send("eth_chainId", [])), 16);
  const rollupConfig = await nodeCall<Record<string, unknown>>("optimism_rollupConfig", []);
  const syncBefore = await syncStatus();
  const l1HeadBefore = await blockRef(l1, "latest");
  const l2HeadBefore = await blockRef(l2, "latest");
  const images = containerImages();

  // ---- deposit: fund the L2 account through the canonical portal path ----
  const depositWei = 500_000_000_000_000_000n;
  const depositL2HeadSnapshot = l2HeadBefore?.number ?? 0;
  console.log("sending L1 -> L2 deposit");
  const depositTx = await portal.depositTransaction(l2Wallet.address, depositWei, 200_000, false, "0x", { value: depositWei });
  const depositReceipt = (await depositTx.wait()) as TransactionReceipt;
  const l2BalanceAfterDeposit = await waitL2Balance(depositWei);
  const depositL2 = await firstL2DepositBlock(depositL2HeadSnapshot, l2Wallet.address);
  if (depositL2 === null) throw new Error("derived L2 deposit transaction not found");

  // ---- L2 settlement activity that must end up in an L1 batch ----
  console.log("sending L2 settlement activity");
  const activity: Array<{ label: string; hash: string; blockNumber: number }> = [];
  for (let index = 1; index <= 6; index += 1) {
    const target = `0x${(0x1000000000000000000000000000000000000000n + BigInt(index)).toString(16)}`;
    const label = `EUROROLLUP-ORDER:${String(index).padStart(3, "0")}:SETTLEMENT-BATCH`;
    const tx = await l2Wallet.sendTransaction({ to: target, value: 0n, data: hexlify(toUtf8Bytes(label)), gasLimit: GAS_LIMIT_WEI + 4_000n });
    const receipt = (await tx.wait()) as TransactionReceipt;
    activity.push({ label, hash: receipt.hash, blockNumber: receipt.blockNumber });
    console.log(`  activity ${index}: L2 block ${receipt.blockNumber} ${receipt.hash}`);
  }
  const activityLastBlock = activity[activity.length - 1]!.blockNumber;

  console.log("waiting for derivation of the activity");
  await waitFor(async () => headNumber(await syncStatus(), "safe_l2") >= activityLastBlock, 600_000, "safe L2 head");
  const syncAfterBatches = await syncStatus();

  // ---- batch publication: calldata batch transactions to the batch inbox ----
  const l1HeadAfterIndexing = Number.parseInt(String(await l1.send("eth_blockNumber", [])), 16);
  const batches: Array<Record<string, unknown>> = [];
  for (let number = (l1HeadBefore?.number ?? 0) + 1; number <= l1HeadAfterIndexing; number += 1) {
    const block = (await l1.send("eth_getBlockByNumber", [`0x${number.toString(16)}`, true])) as Record<string, unknown> | null;
    for (const tx of (block?.["transactions"] as Array<Record<string, unknown>>) ?? []) {
      if (String(tx["to"]).toLowerCase() !== BATCH_INBOX.toLowerCase()) continue;
      const input = String(tx["input"]);
      batches.push({
        l1Block: number,
        txHash: String(tx["hash"]),
        from: String(tx["from"]),
        type: String(tx["type"]),
        nonce: String(tx["nonce"]),
        calldataBytes: Math.max(0, (input.length - 2) / 2),
        versionedBlobHashes: (tx["blobVersionedHashes"] as string[] | undefined) ?? [],
        dataAvailabilityMode: "calldata",
      });
    }
  }
  if (batches.length === 0) throw new Error("no batch transactions found on the batch inbox");
  console.log(`observed ${batches.length} calldata batch transaction(s)`);

  const finalL1Head = await blockRef(l1, "latest");
  const finalL2Head = await blockRef(l2, "latest");
  const l1Safe = await blockRef(l1, "safe");
  const l1Finalized = await blockRef(l1, "finalized");
  // Anvil exposes synthetic safe/finalized tags derived from the head; the
  // execution-only local L1 has no consensus finality. Record the tags but do not
  // claim consensus finality.
  const l1FinalityAvailable = false;
  const l1FinalityNote =
    "anvil exposes synthetic safe/finalized block tags derived from the head; the local L1 has no consensus client, so these are not consensus finality observations. L2 safe/finalized heads from op-node are recorded instead.";

  const protocolRun = {
    schemaVersion: "1.0.0",
    reportId: "A05-protocol-run",
    packId: "A05-chain",
    generatedBy: "pnpm local:evidence",
    generatedAt,
    devnet: {
      orchestrator: "devnet/local/up.sh (anvil L1 clock + pinned OP Stack images)",
      l1: "anvil execution chain (Cancun hardfork) with a synthetic two-second block clock",
      l2: "op-reth execution + op-node sequencer + op-batcher + op-proposer",
      dataAvailabilityMode: "calldata",
      limitations: [
        "The local L1 is execution-only: no consensus client, no beacon API, no blob sidecars.",
        "L1 finality is not modelled; the evidence records the L2 safe/finalized heads and marks L1 finality unavailable.",
        "This is a private development test lane, not a production network.",
      ],
    },
    images,
    rollupConfig: {
      l1ChainId: rollupConfig["l1_chain_id"],
      l2ChainId: rollupConfig["l2_chain_id"],
      blockTimeSeconds: rollupConfig["block_time"],
      maxSequencerDrift: rollupConfig["max_sequencer_drift"],
      seqWindowSize: rollupConfig["seq_window_size"],
      channelTimeout: rollupConfig["channel_timeout"],
      batchInboxAddress: rollup["batch_inbox_address"],
      depositContractAddress: rollup["deposit_contract_address"],
      systemConfigAddress: rollup["l1_system_config_address"],
      genesis: rollup["genesis"],
    },
    chains: {
      l1: {
        chainId: l1ChainId,
        blockTimeSeconds: 2,
        latestHead: finalL1Head,
        safeHead: l1Safe,
        finalizedHead: l1Finalized,
        finalityAvailable: l1FinalityAvailable,
        finalityNote: l1FinalityNote,
      },
      l2: {
        chainId: l2ChainId,
        blockTimeSeconds: rollupConfig["block_time"],
        latestHead: finalL2Head,
        syncStatus: {
          unsafeL2: syncAfterBatches["unsafe_l2"],
          safeL2: syncAfterBatches["safe_l2"],
          finalizedL2: syncAfterBatches["finalized_l2"],
          safeL1: syncAfterBatches["safe_l1"],
          finalizedL1: syncAfterBatches["finalized_l1"],
        },
        headBeforeActivity: l2HeadBefore,
        headAfterActivity: finalL2Head,
        safeHeadAdvancedByActivity: headNumber(syncAfterBatches, "safe_l2") >= activityLastBlock,
      },
    },
    contracts: env.contracts,
    actors: {
      deployer: env.addresses["deployer"],
      admin: env.addresses["admin"],
      systemConfigOwner: env.addresses["systemConfig"],
      unsafeBlockSigner: env.addresses["sequencer"],
      batcher: env.addresses["batcher"],
      proposer: env.addresses["proposer"],
      challenger: env.addresses["challenger"],
      baseFeeRecipient: env.addresses["baseFee"],
      l1FeeRecipient: env.addresses["l1Fee"],
      sequencerFeeRecipient: env.addresses["sequencerFee"],
      withdrawalRecipient: env.addresses["withdrawalRecipient"],
    },
    deposit: {
      l1Tx: depositReceipt.hash,
      l1Block: depositReceipt.blockNumber,
      l2Tx: depositL2.hash,
      l2Block: depositL2.blockNumber,
      value: depositWei.toString(),
      l2BalanceAfterDeposit: l2BalanceAfterDeposit.toString(),
      description: "Canonical deposit through OptimismPortal.depositTransaction, minted on L2 by derivation.",
    },
    l2Activity: {
      description: "Six L2 transactions carrying synthetic settlement-order labels.",
      transactions: activity,
      lastBlock: activityLastBlock,
    },
    batches: {
      dataAvailabilityMode: "calldata",
      batchInboxAddress: rollup["batch_inbox_address"],
      observedBatchTransactions: batches,
      safeHeadAfterIndexing: syncAfterBatches["safe_l2"],
    },
    summary: {
      passed: batches.length > 0 && headNumber(syncAfterBatches, "safe_l2") >= activityLastBlock,
      batchTransactionsObserved: batches.length,
      safeHeadAdvanced: headNumber(syncAfterBatches, "safe_l2") >= activityLastBlock,
      blobDataAvailability: false,
      l1FinalityObserved: l1FinalityAvailable,
    },
  };

  // ---- bridge trace: L2 withdrawal, L1 proof, dispute-game resolution, finalization ----
  console.log("initiating the L2 -> L1 withdrawal");
  const withdrawalAmount = 100_000_000_000_000_000n;
  const withdrawalTx = await bridge.bridgeETHTo(env.addresses["withdrawalRecipient"]!, 200_000, "0x", { value: withdrawalAmount });
  const withdrawalReceipt = (await withdrawalTx.wait()) as TransactionReceipt;
  let withdrawal: Record<string, unknown> | null = null;
  let withdrawalHash = "";
  for (const log of withdrawalReceipt.logs) {
    try {
      const parsed = messagePasserIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "MessagePassed") {
        withdrawalHash = parsed.args["withdrawalHash"] as string;
        withdrawal = {
          nonce: (parsed.args["nonce"] as bigint).toString(),
          sender: parsed.args["sender"] as string,
          target: parsed.args["target"] as string,
          value: (parsed.args["value"] as bigint).toString(),
          gasLimit: (parsed.args["gasLimit"] as bigint).toString(),
          data: parsed.args["data"] as string,
        };
      }
    } catch {
      // not a message-passed log
    }
  }
  if (withdrawal === null) throw new Error("MessagePassed event not found in the withdrawal receipt");
  const withdrawalStruct = {
    nonce: BigInt(withdrawal["nonce"] as string),
    sender: withdrawal["sender"] as string,
    target: withdrawal["target"] as string,
    value: BigInt(withdrawal["value"] as string),
    gasLimit: BigInt(withdrawal["gasLimit"] as string),
    data: withdrawal["data"] as string,
  };
  console.log(`withdrawal ${withdrawalHash} in L2 block ${withdrawalReceipt.blockNumber}`);

  console.log("waiting for a dispute game covering the withdrawal block");
  let gameIndex = -1n;
  let gameAddress = "";
  let gameBlock = 0n;
  await waitFor(
    async () => {
      const count = (await factory.gameCount()) as bigint;
      for (let index = count - 1n; index >= 0n; index -= 1n) {
        const info = (await factory.gameAtIndex(index)) as [bigint, bigint, string];
        const candidate = new Contract(info[2], gameAbi, l1);
        const candidateBlock = (await candidate.l2BlockNumber()) as bigint;
        if (candidateBlock >= BigInt(withdrawalReceipt.blockNumber)) {
          gameIndex = index;
          gameAddress = info[2];
          gameBlock = candidateBlock;
          return true;
        }
      }
      return false;
    },
    600_000,
    "dispute game covering the withdrawal",
  );
  console.log(`game ${gameIndex} at ${gameAddress} covering L2 block ${gameBlock}`);

  const game = new Contract(gameAddress, gameAbi, l1Wallet);
  const rootClaim = (await game.rootClaim()) as string;
  const gameCreatedAt = (await game.createdAt()) as bigint;
  const gameMaxClock = (await game.maxClockDuration()) as bigint;
  const gameClockExtension = (await game.clockExtension()) as bigint;
  const output = await nodeCall<Record<string, unknown>>("optimism_outputAtBlock", [`0x${gameBlock.toString(16)}`]);
  const blockRefForGame = output["blockRef"] as Record<string, unknown>;
  const outputRootProof = {
    version: output["version"],
    stateRoot: output["stateRoot"],
    messagePasserStorageRoot: output["withdrawalStorageRoot"],
    latestBlockhash: blockRefForGame["hash"],
  };
  if (String(output["outputRoot"]).toLowerCase() !== rootClaim.toLowerCase()) {
    throw new Error("output root at the game's L2 block does not match the game root claim");
  }

  const abiCoder = AbiCoder.defaultAbiCoder();
  const storageSlot = keccak256(abiCoder.encode(["bytes32", "uint256"], [withdrawalHash, 0]));
  const proofResponse = (await l2.send("eth_getProof", [L2_TO_L1_MESSAGE_PASSER, [storageSlot], blockRefForGame["hash"]])) as {
    storageProof: Array<{ value: string; proof: string[] }>;
  };
  const storageProof = proofResponse.storageProof[0]!;
  if (BigInt(storageProof.value) !== 1n) throw new Error("withdrawal is not recorded in the L2ToL1MessagePasser at the game block");

  console.log("proving the withdrawal on L1");
  const proveTx = await portal.proveWithdrawalTransaction(withdrawalStruct, gameIndex, outputRootProof, storageProof.proof);
  const proveReceipt = (await proveTx.wait()) as TransactionReceipt;
  if (proveReceipt.status !== 1) throw new Error("proveWithdrawalTransaction failed");
  const proven = (await portalRead.provenWithdrawals(withdrawalHash, l1Wallet.address)) as [string, bigint];

  const proofMaturity = (await portalRead.proofMaturityDelaySeconds()) as bigint;
  const finalityDelay = (await portalRead.disputeGameFinalityDelaySeconds()) as bigint;

  const l2HeadBeforeAcceleration = await blockRef(l2, "latest");
  const l1HeadBeforeAcceleration = await blockRef(l1, "latest");

  console.log("freezing the L2 pipeline and accelerating the private L1 clock for game resolution");
  execFileSync("docker", ["stop", "op-node-local", "op-batcher-local", "op-proposer-local"], { stdio: "ignore" });

  const accelerations: Array<Record<string, unknown>> = [];
  async function advanceL1Clock(targetTimestamp: bigint): Promise<void> {
    const head = await blockRef(l1, "latest");
    const delta = targetTimestamp - BigInt(head?.timestamp ?? 0);
    if (delta <= 0n) return;
    const before = head?.timestamp ?? 0;
    await l1.send("evm_increaseTime", [Number(delta)]);
    await l1.send("evm_mine", []);
    const after = await blockRef(l1, "latest");
    accelerations.push({ requestedSeconds: Number(delta), before, after: after?.timestamp ?? 0 });
  }

  await advanceL1Clock(gameCreatedAt + gameMaxClock + 120n);
  let resolution: Record<string, unknown>;
  let resolveClaimHash: string | null = null;
  let resolveHash: string | null = null;
  try {
    const receipt = (await (await game.resolveClaim(0, 1)).wait()) as TransactionReceipt;
    resolveClaimHash = receipt.hash;
  } catch (error) {
    console.log(`resolveClaim not required: ${(error as Error).message.slice(0, 120)}`);
  }
  try {
    const receipt = (await (await game.resolve()).wait()) as TransactionReceipt;
    resolveHash = receipt.hash;
  } catch (error) {
    console.log(`resolve not required: ${(error as Error).message.slice(0, 120)}`);
  }
  const gameStatus = (await game.status()) as bigint;
  const gameResolvedAt = (await game.resolvedAt()) as bigint;
  if (gameStatus !== 2n) throw new Error(`dispute game did not resolve to DEFENDER_WINS (status ${gameStatus.toString()})`);
  resolution = { status: gameStatus.toString(), resolvedAt: gameResolvedAt.toString(), resolveClaimTx: resolveClaimHash, resolveTx: resolveHash };

  await advanceL1Clock(gameCreatedAt + proofMaturity + finalityDelay + 240n);
  console.log("finalizing the withdrawal on L1");
  const recipientBefore = await l1.getBalance(env.addresses["withdrawalRecipient"]!);
  const finalizeTx = await portal.finalizeWithdrawalTransaction(withdrawalStruct);
  const finalizeReceipt = (await finalizeTx.wait()) as TransactionReceipt;
  const recipientAfter = await l1.getBalance(env.addresses["withdrawalRecipient"]!);
  if (finalizeReceipt.status !== 1) throw new Error("finalizeWithdrawalTransaction failed");
  const l1CrossDomainMessenger = env.contracts["L1CrossDomainMessengerProxy"]?.toLowerCase() ?? "";
  const relayedByMessenger = finalizeReceipt.logs.some((log) => log.address.toLowerCase() === l1CrossDomainMessenger);
  console.log(`finalized ${finalizeReceipt.hash}, recipient delta ${(recipientAfter - recipientBefore).toString()}`);

  const bridgeTrace = {
    schemaVersion: "1.0.0",
    reportId: "A05-bridge-trace",
    packId: "A05-chain",
    generatedBy: "pnpm local:evidence",
    generatedAt,
    devnet: {
      orchestrator: "devnet/local/up.sh",
      l1: "anvil execution chain with a synthetic two-second block clock",
      l2: "op-reth execution + op-node sequencer + op-batcher + op-proposer",
      blockTimeSeconds: { l1: 2, l2: rollupConfig["block_time"] },
    },
    contracts: env.contracts,
    timers: {
      proofMaturityDelaySeconds: proofMaturity.toString(),
      disputeGameFinalityDelaySeconds: finalityDelay.toString(),
      disputeGameMaxClockDurationSeconds: gameMaxClock.toString(),
      disputeGameClockExtensionSeconds: gameClockExtension.toString(),
      respectedGameType: env.gameType,
      timeAcceleration: accelerations,
      timeAccelerationNote:
        "The private anvil L1 clock is advanced with evm_increaseTime so the production portal timers can be satisfied in a test lane. These are the real configured timers, not shortened ones.",
    },
    withdrawalInitiation: {
      l2Tx: withdrawalReceipt.hash,
      l2Block: withdrawalReceipt.blockNumber,
      withdrawalHash,
      ...withdrawal,
    },
    outputRootProof: {
      gameIndex: gameIndex.toString(),
      gameAddress,
      l2Block: gameBlock.toString(),
      rootClaim,
      outputRoot: output["outputRoot"],
      version: outputRootProof.version,
      stateRoot: outputRootProof.stateRoot,
      messagePasserStorageRoot: outputRootProof.messagePasserStorageRoot,
      latestBlockhash: outputRootProof.latestBlockhash,
      withdrawalStorageSlot: storageSlot,
    },
    l1Proving: {
      txHash: proveReceipt.hash,
      blockNumber: proveReceipt.blockNumber,
      provenGame: proven[0],
      provenTimestamp: proven[1].toString(),
    },
    disputeGameResolution: resolution,
    finalization: {
      txHash: finalizeReceipt.hash,
      blockNumber: finalizeReceipt.blockNumber,
      status: finalizeReceipt.status,
      recipient: env.addresses["withdrawalRecipient"],
      recipientDeltaWei: (recipientAfter - recipientBefore).toString(),
      relayedByL1CrossDomainMessenger: relayedByMessenger,
      withdrawalValueWei: withdrawalAmount.toString(),
    },
    heads: {
      beforeTimeAcceleration: { l1: l1HeadBeforeAcceleration, l2: l2HeadBeforeAcceleration },
      afterFinalization: { l1: await blockRef(l1, "latest"), l2: l2HeadBeforeAcceleration },
    },
    summary: {
      passed:
        proveReceipt.status === 1 &&
        gameStatus === 2n &&
        finalizeReceipt.status === 1 &&
        (recipientAfter - recipientBefore) === withdrawalAmount,
      withdrawalProven: true,
      disputeGameResolved: gameStatus === 2n,
      withdrawalFinalized: finalizeReceipt.status === 1,
    },
  };

  writeFileSync(join(evidenceDir, "protocol-run.json"), `${JSON.stringify(protocolRun, null, 2)}\n`);
  writeFileSync(join(evidenceDir, "bridge-trace.json"), `${JSON.stringify(bridgeTrace, null, 2)}\n`);
  console.log("wrote evidence/a05/protocol-run.json");
  console.log("wrote evidence/a05/bridge-trace.json");
  if (!protocolRun.summary.passed || !bridgeTrace.summary.passed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
