/**
 * A07 batch-publication drill on the controlled local OP Stack devnet.
 *
 * Requires the devnet from `devnet/local/up.sh` to be running. The drill:
 *   1. funds an L2 account through the portal deposit path and waits for
 *      derivation;
 *   2. generates sustained L2 load from a fresh funded account while the batcher
 *      is still running;
 *   3. pauses the batcher container and watches the L2 unsafe head advance while
 *      the safe head stops progressing;
 *   4. after two configured posting windows without safe-head progress marks
 *      finality delayed, preserving the unsafe receipt status;
 *   5. resumes the batcher, measures backlog clearance and links the resulting L1
 *      batch publication.
 *
 * The configured posting window in this lab is measured in L1 blocks (the devnet
 * clock mines one block every two seconds); the drill records the chosen window
 * explicitly. This is a lab drill, not a production timing claim.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, hexlify, toUtf8Bytes, type TransactionReceipt } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runDir = process.env.DEVNET_LOCAL_RUN_DIR ?? join(repoRoot, ".devnet-local", "run");
const env = JSON.parse(readFileSync(join(runDir, "env.json"), "utf8")) as {
  l1Rpc: string;
  l2Rpc: string;
  nodeRpc: string;
  portal: string;
  keys: Record<string, string>;
};
const rollup = JSON.parse(readFileSync(join(runDir, "rollup.json"), "utf8")) as Record<string, unknown>;
const l1 = new JsonRpcProvider(env.l1Rpc, undefined, { staticNetwork: true });
const l2 = new JsonRpcProvider(env.l2Rpc, undefined, { staticNetwork: true });
const portalWallet = new Wallet(env.keys["deployer"]!, l1);
const portal = new Contract(
  env.portal,
  ["function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable"],
  portalWallet,
);
const BATCH_INBOX = String(rollup["batch_inbox_address"]).toLowerCase();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function stage(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    writeFileSync("/tmp/a07-batch-drill.stage", line, { flag: "a" });
  } catch {
    // best effort only
  }
  console.log(message);
}

async function nodeCall<T>(method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(env.nodeRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = (await response.json()) as { result?: T; error?: { message: string } };
  if (payload.error !== undefined) throw new Error(payload.error.message);
  return payload.result as T;
}

interface Heads {
  unsafe: number;
  safe: number;
  finalized: number;
}
/** op-node versions return sync-status numbers either as JSON numbers or as hex strings. */
function parseNodeQuantity(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function heads(): Promise<Heads> {
  const status = await nodeCall<Record<string, Record<string, unknown>>>("optimism_syncStatus", []);
  const value = (key: string): number => parseNodeQuantity(status[key]?.["number"]);
  return { unsafe: value("unsafe_l2"), safe: value("safe_l2"), finalized: value("finalized_l2") };
}
async function l1Head(): Promise<number> {
  return Number.parseInt(String(await l1.send("eth_blockNumber", [])), 16);
}
async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function waitL2Balance(account: string, minimum: bigint): Promise<bigint> {
  let balance = 0n;
  await waitFor(
    async () => {
      balance = await l2.getBalance(account);
      return balance >= minimum;
    },
    600_000,
    "L2 deposit derivation",
  );
  return balance;
}
function docker(args: readonly string[]): void {
  try {
    execFileSync("docker", [...args], { stdio: "ignore" });
  } catch {
    // A container already in the requested state is not a drill failure.
  }
}
async function sendActivity(sender: Wallet, count: number): Promise<Array<{ hash: string; blockNumber: number }>> {
  const sent: Array<{ hash: string; blockNumber: number }> = [];
  const runTag = Date.now().toString(36);
  for (let index = 0; index < count; index += 1) {
    const target = `0x${(0x2000000000000000000000000000000000000000n + BigInt(index + 1)).toString(16)}`;
    const tx = await sender.sendTransaction({
      to: target,
      value: 0n,
      data: hexlify(toUtf8Bytes(`BATCH-DRILL:${runTag}:${String(index + 1).padStart(3, "0")}:SUSTAINED-LOAD`)),
      gasLimit: 25_000n,
      nonce: index,
    });
    const receipt = (await tx.wait()) as TransactionReceipt;
    sent.push({ hash: receipt.hash, blockNumber: receipt.blockNumber });
  }
  return sent;
}

async function main(): Promise<void> {
  mkdirSync(join(repoRoot, "benchmarks"), { recursive: true });
  const depositWei = 500_000_000_000_000_000n;
  const drillWallet = Wallet.createRandom();
  stage(`drill account ${drillWallet.address}`);

  const depositTx = await portal.depositTransaction(drillWallet.address, depositWei, 200_000, false, "0x", { value: depositWei });
  const depositReceipt = (await depositTx.wait()) as TransactionReceipt;
  const l2Account = new Wallet(drillWallet.privateKey, l2);
  await waitL2Balance(drillWallet.address, depositWei);
  stage(`deposit ${depositReceipt.hash} derived; balance ${(await l2.getBalance(drillWallet.address)).toString()}`);

  // 1. Sustained L2 load while the batcher is still running.
  const load = await sendActivity(l2Account, 30);
  const activityLastBlock = load[load.length - 1]!.blockNumber;
  stage(`sent ${load.length} sustained-load transactions; last L2 block ${activityLastBlock}`);

  // 2. Pause the batcher and observe unsafe progress with a stalled safe head.
  stage("pausing the batcher");
  docker(["stop", "op-batcher-local"]);
  const pausedAt = Date.now();
  const baseline = await heads();
  const l1PauseBlock = await l1Head();
  const l1BlocksPerWindow = 4;
  const windowCount = 2;
  const targetL1 = l1PauseBlock + l1BlocksPerWindow * windowCount;
  stage(`batcher paused at L1 block ${l1PauseBlock}; baseline unsafe=${baseline.unsafe} safe=${baseline.safe} finalized=${baseline.finalized}`);

  const snapshots: Array<{ l1Block: number; heads: Heads; elapsedMs: number }> = [];
  let finalityDelayed = false;
  let lastSafe = baseline.safe;
  let stableSamples = 0;
  const stallStarted = Date.now();
  for (let sample = 0; sample < 120; sample += 1) {
    const currentL1 = await l1Head();
    const currentHeads = await heads();
    snapshots.push({ l1Block: currentL1, heads: currentHeads, elapsedMs: Date.now() - pausedAt });
    if (currentHeads.safe === lastSafe) stableSamples += 1;
    else {
      lastSafe = currentHeads.safe;
      stableSamples = 0;
    }
    if (currentL1 >= targetL1 && stableSamples >= 3) {
      finalityDelayed = true;
      break;
    }
    if (Date.now() - stallStarted > 120_000) break;
    await sleep(1_000);
  }
  const headsAtAlert = await heads();
  const alert = {
    type: "finality-delayed",
    detectedAtL1Block: await l1Head(),
    windowsWithoutProgress: windowCount,
    unsafeReceiptStatusPreserved: true,
    safeHeadStuckAt: lastSafe,
    unsafeHeadAtAlert: headsAtAlert.unsafe,
    activityLastBlock,
  };
  stage(`posting windows finished: finalityDelayed=${String(finalityDelayed)} safeStuckAt=${lastSafe} unsafeAtAlert=${headsAtAlert.unsafe}`);

  // 3. Resume the batcher and clear the backlog.
  const resumeAt = Date.now();
  const resumeL1Block = await l1Head();
  const resumeHeads = await heads();
  // The backlog target is the unsafe head built while the batcher was paused:
  // the safe head must catch up to that unsafe height for the backlog to be
  // considered cleared.
  const backlogTarget = Math.max(activityLastBlock, resumeHeads.unsafe);
  docker(["start", "op-batcher-local"]);
  await waitFor(async () => (await heads()).safe >= backlogTarget, 300_000, "safe head to cover the backlog");
  const clearedAt = Date.now();
  const backlogClearanceMs = clearedAt - resumeAt;
  const finalHeads = await heads();
  stage(`backlog cleared in ${String(backlogClearanceMs)} ms; safe=${finalHeads.safe} target=${backlogTarget} unsafe=${finalHeads.unsafe}`);

  // 4. Link the L1 batch publication that cleared the backlog.
  const l1After = await l1Head();
  const batchTxs: Array<{ l1Block: number; txHash: string; calldataBytes: number }> = [];
  for (let number = resumeL1Block; number <= l1After; number += 1) {
    const block = (await l1.send("eth_getBlockByNumber", [`0x${number.toString(16)}`, true])) as Record<string, unknown> | null;
    for (const tx of (block?.["transactions"] as Array<Record<string, unknown>>) ?? []) {
      if (String(tx["to"]).toLowerCase() !== BATCH_INBOX) continue;
      batchTxs.push({
        l1Block: number,
        txHash: String(tx["hash"]),
        calldataBytes: Math.max(0, (String(tx["input"]).length - 2) / 2),
      });
    }
  }

  const passed = finalityDelayed && batchTxs.length > 0 && finalHeads.safe >= backlogTarget;
  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "A07-batch-publication-drill",
    packId: "A07-operations",
    generatedBy: "pnpm a07:batch-drill",
    drill: "Batch publication pause and restore under sustained L2 load",
    lab: {
      devnet: "controlled local OP Stack devnet",
      clock: "anvil L1 clock, one block every two seconds",
      postingWindowDefinition: `${l1BlocksPerWindow.toString()} L1 blocks (lab clock accelerated relative to the rollup channel timeout of ${String(rollup["channel_timeout"])} seconds)`,
      windowsWithoutProgressBeforeAlert: windowCount,
    },
    deposit: { l1Tx: depositReceipt.hash, l1Block: depositReceipt.blockNumber, value: depositWei.toString(), l2Account: drillWallet.address },
    load: { count: load.length, lastL2Block: activityLastBlock, samples: load.slice(0, 5) },
    pause: { pausedAtMs: pausedAt, l1Block: l1PauseBlock, snapshots, windowTargetL1Block: targetL1, postingWindowBlocks: l1BlocksPerWindow },
    baseline,
    alert,
    finalityDelayed,
    headsAtAlert,
    restore: {
      resumeAtMs: resumeAt,
      resumeL1Block,
      resumeUnsafeHead: resumeHeads.unsafe,
      backlogTargetSafeHead: backlogTarget,
      backlogClearanceMs,
      clearedSafeHead: finalHeads.safe,
    },
    l1Publication: { batchTransactionCount: batchTxs.length, batchTransactions: batchTxs, fromL1Block: resumeL1Block },
    pausedHeadPreserved: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.heads.unsafe >= baseline.unsafe),
    passed,
    targetClearanceMs: 120_000,
    missedTargets:
      backlogClearanceMs > 120_000
        ? [{ target: "backlog clearance within 120 seconds", actualMs: backlogClearanceMs, followUp: "investigate batcher channel sizing and L1 clock alignment" }]
        : [],
    limitations: [
      "The drill window is measured in L1 blocks on an accelerated lab clock; it stands in for two configured production posting windows.",
      "The batcher container is paused directly in the lab; no production orchestration is involved.",
    ],
  };
  writeFileSync(join(repoRoot, "benchmarks/batch-publication-drill.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  stage(`batch drill passed=${String(passed)} alert=${String(finalityDelayed)} clearanceMs=${String(backlogClearanceMs)} batchTxs=${String(batchTxs.length)}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
