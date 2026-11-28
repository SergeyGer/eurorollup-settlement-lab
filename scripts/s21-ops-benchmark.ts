/**
 * S21 / OPS-01 batch-setting benchmark.
 *
 * Runs the identical 200-order arrival schedule three times for each op-batcher maximum
 * channel duration (4 and 12 L1 blocks) on the pinned consensus lane. For every run it
 * retains the raw order timestamps, batch transactions (with L1 receipts and blob data),
 * completed/failed counts, batch fill, L1 expenditure and the unsafe-to-safe latency
 * samples; then publishes p50/p95, the percentile method, per-success cost and the
 * selected setting (or the miss with the chosen trade-off).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s21");
const workDir = join(repoRoot, "tmp-s21");
const ENCLAVE = process.env.NET01_ENCLAVE ?? "net01h";
const json = (value: unknown): string => JSON.stringify(value, (_k, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ORDER_COUNT = 200;
const WAVES = 10;
const WAVE_DELAY_MS = 100;
const MAX_CHANNEL_DURATIONS = [4, 12] as const;
const RUNS_PER_SETTING = 3;
const LATENCY_TARGET_MS = 240_000;
const SENDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const batcherImage = "us-docker.pkg.dev/oplabs-tools-artifacts/images/op-batcher:v1.16.11";

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { encoding: "utf8", ...(input === undefined ? {} : { input }) }).trim();
}
function dockerNames(): string[] {
  return docker(["ps", "--format", "{{.Names}}"]).split("\n").filter(Boolean);
}
function containerMatching(needle: string): string | null {
  return dockerNames().find((name) => name.includes(needle)) ?? null;
}
function hostPort(container: string, containerPort: number): number {
  const output = docker(["port", container, `${String(containerPort)}/tcp`]);
  const match = /:(\d+)$/.exec(output);
  if (match === null) throw new Error(`no host port for ${container}:${String(containerPort)}`);
  return Number(match[1]);
}
async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string, intervalMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function nearestRank(samples: readonly number[], percentile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1]!;
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  // Lane discovery: the pinned kurtosis consensus lane, or the controlled local OP Stack
  // devnet (anvil L1, op-reth/op-node/op-batcher, calldata DA) when the consensus lane is
  // unavailable. Both record the same measurements.
  const isKurtosisLane = containerMatching("el-1-geth-lighthouse") !== null && containerMatching("op-el-16584") !== null;
  const candidateKeys: Array<{ key: string; label: string }> = [];
  let l1Rpc: string;
  let l2Rpc: string;
  let nodeRpc: string;
  let proposerRpc: string | null = null;
  let inbox: string;
  let batcherKey: string;
  let daMode: "blobs" | "calldata";
  let laneMode: string;
  let laneDetail: Record<string, any>;
  if (isKurtosisLane) {
    const l1Container = containerMatching("el-1-geth-lighthouse")!;
    const l2Container = containerMatching("op-el-16584")!;
    const nodeContainer = containerMatching("op-cl-16584")!;
    const proposerContainer = containerMatching("op-proposer-16584");
    l1Rpc = `http://127.0.0.1:${String(hostPort(l1Container, 8545))}`;
    l2Rpc = `http://127.0.0.1:${String(hostPort(l2Container, 8545))}`;
    nodeRpc = `http://127.0.0.1:${String(hostPort(nodeContainer, 8547))}`;
    proposerRpc = proposerContainer === null ? null : `http://127.0.0.1:${String(hostPort(proposerContainer, 8560))}`;
    for (const artifact of ["op-deployer-configs"]) execFileSync("kurtosis", ["files", "download", ENCLAVE, artifact, join(workDir, artifact)], { stdio: "ignore" });
    const configs = join(workDir, "op-deployer-configs");
    const rollup = JSON.parse(readFileSync(join(configs, "rollup-16584.json"), "utf8")) as Record<string, any>;
    inbox = String(rollup["batch_inbox_address"]).toLowerCase();
    const wallets = JSON.parse(readFileSync(join(configs, "wallets.json"), "utf8")) as Record<string, any>;
    const chainWallet = (wallets["16584"] ?? wallets) as Record<string, unknown>;
    batcherKey = (chainWallet["batcherPrivateKey"] as string | undefined) ?? (JSON.parse(readFileSync(join(configs, "batcher-16584.json"), "utf8")) as Record<string, any>)["privateKey"];
    const collectKeys = (value: unknown, path = ""): void => {
      if (value === null || typeof value !== "object") return;
      for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === "string" && /^0x[0-9a-fA-F]{64}$/.test(item) && name.toLowerCase().endsWith("privatekey")) candidateKeys.push({ key: item, label: `${path}.${name}` });
        else if (item !== null && typeof item === "object") collectKeys(item, `${path}.${name}`);
      }
    };
    collectKeys(wallets);
    daMode = "blobs";
    laneMode = "kurtosis-consensus-lane";
    laneDetail = { enclave: ENCLAVE, l1Rpc, l2Rpc, nodeRpc, proposerRpc, batcherImage, batchInbox: inbox, consensus: "lighthouse minimal" };
  } else {
    const envPath = join(repoRoot, ".devnet-local", "run", "env.json");
    const rollupPath = join(repoRoot, ".devnet-local", "run", "rollup.json");
    if (!existsSync(envPath) || !existsSync(rollupPath)) throw new Error("no kurtosis consensus lane and no .devnet-local/run/env.json; run pnpm net01:up or devnet/local/up.sh first");
    const env = JSON.parse(readFileSync(envPath, "utf8")) as Record<string, any>;
    const rollup = JSON.parse(readFileSync(rollupPath, "utf8")) as Record<string, any>;
    l1Rpc = String(env["l1Rpc"]);
    l2Rpc = String(env["l2Rpc"]);
    nodeRpc = String(env["nodeRpc"]);
    inbox = String(rollup["batch_inbox_address"]).toLowerCase();
    batcherKey = String(env["keys"]["batcher"]);
    for (const [label, key] of Object.entries(env["keys"] as Record<string, string>)) candidateKeys.push({ key, label: `env.keys.${label}` });
    daMode = "calldata";
    laneMode = "local-op-stack-devnet";
    laneDetail = { workDir: env["workDir"], l1Rpc, l2Rpc, nodeRpc, batcherImage, batchInbox: inbox, consensus: "anvil L1 with a two-second block clock" };
  }
  const provider = new JsonRpcProvider(l2Rpc, undefined, { staticNetwork: true });
  const l1Provider = new JsonRpcProvider(l1Rpc, undefined, { staticNetwork: true });
  let sender: Wallet | null = null;
  const balances: Array<{ label: string; address: string; balance: string }> = [];
  for (const candidate of candidateKeys) {
    const wallet = new Wallet(candidate.key, provider);
    const balance = await provider.getBalance(wallet.address);
    balances.push({ label: candidate.label, address: wallet.address, balance: balance.toString() });
    if (sender === null && balance >= 10n ** 18n) sender = wallet;
  }
  if (sender === null) throw new Error(`no funded development account on L2: ${JSON.stringify(balances)}`);
  const l2ChainId = Number(await rpc(l2Rpc, "eth_chainId"));
  if (l2ChainId !== 16584) throw new Error(`unexpected L2 chain id ${String(l2ChainId)}`);
  let customBatcher: string | null = null;
  const stopBatchers = (): void => {
    for (const name of dockerNames().filter((entry) => entry.includes("op-batcher-16584") || entry.includes("op-batcher-local") || entry === "s21-batcher")) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    customBatcher = null;
  };
  const startBatcher = async (maxChannelDuration: number): Promise<void> => {
    stopBatchers();
    customBatcher = "s21-batcher";
    const daFlags = daMode === "blobs" ? ["--data-availability-type=blobs"] : ["--data-availability-type=calldata", "--throttle.unsafe-da-bytes-lower-threshold=0"];
    const safetyFlags = daMode === "blobs" ? ["--sub-safety-margin=6", "--resubmission-timeout=30s"] : ["--sub-safety-margin=2", "--resubmission-timeout=20s"];
    docker(["run", "-d", "--name", customBatcher, "--network", "host", batcherImage, "op-batcher",
      `--l1-eth-rpc=${l1Rpc}`, `--l2-eth-rpc=${l2Rpc}`, `--rollup-rpc=${nodeRpc}`, `--private-key=${batcherKey}`,
      ...daFlags, `--max-channel-duration=${String(maxChannelDuration)}`, "--poll-interval=1s", "--num-confirmations=1", ...safetyFlags,
      "--rpc.addr=0.0.0.0", "--rpc.port=9548", "--rpc.enable-admin", "--log.level=info"]);
    await sleep(5_000);
    if (!dockerNames().includes(customBatcher)) throw new Error("custom batcher did not stay running");
  };
  const batchTxDetails = async (fromBlock: number): Promise<Array<Record<string, any>>> => {
    const details: Array<Record<string, any>> = [];
    const head = Number(await rpc(l1Rpc, "eth_blockNumber"));
    for (let blockNumber = fromBlock; blockNumber <= head; blockNumber++) {
      const block = (await rpc(l1Rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, true])) as Record<string, any> | null;
      if (block === null) continue;
      for (const tx of (block["transactions"] as Array<Record<string, any>>) ?? []) {
        if (String(tx["to"]).toLowerCase() !== inbox) continue;
        const receipt = (await rpc(l1Rpc, "eth_getTransactionReceipt", [tx["hash"]])) as Record<string, any> | null;
        const gasUsed = BigInt(receipt?.["gasUsed"] ?? "0x0");
        const effectiveGasPrice = BigInt(receipt?.["effectiveGasPrice"] ?? "0x0");
        const blobGasUsed = BigInt(receipt?.["blobGasUsed"] ?? "0x0");
        const blobGasPrice = BigInt(receipt?.["blobGasPrice"] ?? "0x0");
        const blobVersionedHashes = (tx["blobVersionedHashes"] as string[] | undefined) ?? [];
        const calldataBytes = Math.max(0, (String(tx["input"] ?? "0x").length - 2) / 2);
        details.push({ txHash: tx["hash"], blockNumber, blockHash: block["hash"], blockTimestamp: Number(block["timestamp"]), type: Number(tx["type"]), blobCount: blobVersionedHashes.length, blobVersionedHashes, calldataBytes, gasUsed: gasUsed.toString(), effectiveGasPriceWei: effectiveGasPrice.toString(), blobGasUsed: blobGasUsed.toString(), blobGasPriceWei: blobGasPrice.toString(), costWei: (gasUsed * effectiveGasPrice + blobGasUsed * blobGasPrice).toString() });
      }
    }
    return details;
  };

  const runs: Array<Record<string, any>> = [];
  const runSeeds: Record<number, number[]> = { 4: [2100401, 2100402, 2100403], 12: [2101201, 2101202, 2101203] };
  for (const setting of MAX_CHANNEL_DURATIONS) {
    await startBatcher(setting);
    for (let runIndex = 0; runIndex < RUNS_PER_SETTING; runIndex++) {
      const seed = runSeeds[setting]![runIndex]!;
      const runId = `D${String(setting)}-R${String(runIndex + 1)}`;
      console.log(`run ${runId}: starting (seed ${String(seed)})`);
      const startL1 = Number(await rpc(l1Rpc, "eth_blockNumber"));
      const startNonce = await provider.getTransactionCount(sender.address, "pending");
      const orders: Array<{ index: number; to: string; nonce: number; submittedAt: number; txHash: string | null }> = [];
      const waveSize = ORDER_COUNT / WAVES;
      const sendWave = async (wave: number): Promise<void> => {
        const pending: Array<Promise<void>> = [];
        for (let index = wave * waveSize; index < (wave + 1) * waveSize; index++) {
          const to = `0x${keccak256(toUtf8Bytes(`ops01-order:${String(seed)}:${String(index)}`)).slice(-40)}`;
          const nonce = startNonce + index;
          const submittedAt = Date.now();
          orders.push({ index, to, nonce, submittedAt, txHash: null });
          pending.push((async () => {
            let tx: Awaited<ReturnType<Wallet["sendTransaction"]>> | null = null;
            for (let attempt = 0; attempt < 60 && tx === null; attempt++) {
              try {
                tx = await sender.sendTransaction({ to, value: 10n ** 15n, nonce, gasLimit: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!message.includes("txpool is full") && !message.includes("already known")) throw error;
                await sleep(500);
              }
            }
            if (tx === null) throw new Error("transaction could not be submitted");
            orders[index]!.txHash = tx.hash;
            await tx.wait();
          })());
        }
        await Promise.all(pending);
      };
      for (let wave = 0; wave < WAVES; wave++) {
        await sendWave(wave);
        if (wave < WAVES - 1) await sleep(WAVE_DELAY_MS);
      }
      const unsafeObservedAt = Date.now();
      const receipts = await Promise.all(orders.map((order) => provider.getTransactionReceipt(order.txHash!)));
      const completed = receipts.filter((receipt) => receipt !== null && receipt.status === 1).length;
      const failed = ORDER_COUNT - completed;
      const blockNumbers = receipts.map((receipt) => receipt?.blockNumber ?? 0);
      const maxBlock = Math.max(...blockNumbers);
      await waitFor(async () => {
        const status = (await rpc(nodeRpc, "optimism_syncStatus")) as Record<string, any>;
        return Number(status["safe_l2"]?.["number"] ?? 0) >= maxBlock;
      }, 600_000, `safe head >= ${String(maxBlock)} for ${runId}`, 1_000);
      const safeObservedAt = Date.now();
      const batchTxs = await batchTxDetails(startL1);
      if (batchTxs.length === 0) throw new Error(`${runId}: no batch transactions were observed`);
      const l1ExpenditureWei = batchTxs.reduce((sum, entry) => sum + BigInt(String(entry["costWei"])), 0n);
      const blobCount = batchTxs.reduce((sum, entry) => sum + Number(entry["blobCount"]), 0);
      const batchBytes = batchTxs.reduce((sum, entry) => sum + Number(entry["calldataBytes"]) + Number(entry["blobCount"]) * 131_072, 0);
      const latencySamples = orders.map((order) => Math.max(0, safeObservedAt - order.submittedAt));
      // Batch fill is reported in blob-equivalents (data bytes / 131072) so the calldata and
      // blob lanes are comparable; blob slots are also recorded for the blob lane.
      const batchFill = Math.min(1, batchBytes / 131_072);
      const unsafeLatency = safeObservedAt - unsafeObservedAt;
      const run = {
        runId,
        settingBlocks: setting,
        seed,
        chainId: l2ChainId,
        daMode,
        arrivalSchedule: { orders: ORDER_COUNT, waves: WAVES, waveSize, delayBetweenWavesMs: WAVE_DELAY_MS },
        feeInputs: { maxFeePerGasWei: "2000000000", maxPriorityFeePerGasWei: "1000000000" },
        l2Blocks: { startL1, startNonce, maxOrderBlock: maxBlock, minOrderBlock: Math.min(...blockNumbers) },
        completed,
        failed,
        batch: {
          txCount: batchTxs.length,
          blobCount,
          bytes: batchBytes,
          fillRatio: Number(batchFill.toFixed(4)),
          fillDefinition: "batch data bytes / 131072 (blob-equivalents); blended for calldata and blob transactions",
          txs: batchTxs,
        },
        l1ExpenditureWei: l1ExpenditureWei.toString(),
        perSuccessCostWei: completed === 0 ? null : (l1ExpenditureWei / BigInt(completed)).toString(),
        latency: {
          percentileMethod: "nearest-rank over all order samples (rank = ceil(p/100 * n))",
          samplesMs: latencySamples,
          p50Ms: nearestRank(latencySamples, 50),
          p95Ms: nearestRank(latencySamples, 95),
          unsafeBatchDelayMs: unsafeLatency,
        },
        orders,
      };
      runs.push(run);
      console.log(`run ${runId}: completed=${String(completed)} batchTxs=${String(batchTxs.length)} blobs=${String(blobCount)} p50=${String(run.latency.p50Ms)}ms p95=${String(run.latency.p95Ms)}ms cost/success=${String(run.perSuccessCostWei)} wei`);
      await sleep(3_000);
    }
  }
  // Selection.
  const aggregate = MAX_CHANNEL_DURATIONS.map((setting) => {
    const settingRuns = runs.filter((run) => run.settingBlocks === setting);
    const allSamples = settingRuns.flatMap((run) => run.latency.samplesMs as number[]);
    const p95 = nearestRank(allSamples, 95);
    const p50 = nearestRank(allSamples, 50);
    const meanCost = settingRuns.reduce((sum, run) => sum + BigInt(String(run.perSuccessCostWei)), 0n) / BigInt(settingRuns.length);
    const meanCompleted = settingRuns.reduce((sum, run) => sum + Number(run.completed), 0) / settingRuns.length;
    const meetsTarget = p95 <= LATENCY_TARGET_MS;
    return { settingBlocks: setting, runs: settingRuns.length, samples: allSamples.length, p50Ms: p50, p95Ms: p95, meetsTarget, meanPerSuccessCostWei: meanCost.toString(), meanCompleted };
  });
  const qualifying = aggregate.filter((entry) => entry.meetsTarget);
  const selected = (qualifying.length > 0 ? qualifying.reduce((best, current) => (BigInt(current.meanPerSuccessCostWei) < BigInt(best.meanPerSuccessCostWei) ? current : best)) : null) as typeof aggregate[number] | null;
  const miss = selected === null;
  const chosenTradeoff = selected === null
    ? (aggregate.reduce((best, current) => (current.p95Ms < best.p95Ms ? current : best)))
    : selected;
  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "S21-OPS-01-batch-setting-benchmark",
    packId: "S21",
    generatedBy: "pnpm s21:run",
    generatedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    lane: { mode: laneMode, chainId: l2ChainId, daMode, ...laneDetail },
    controls: { orderCount: ORDER_COUNT, runsPerSetting: RUNS_PER_SETTING, settingsBlocks: MAX_CHANNEL_DURATIONS, seedSchedule: runSeeds, arrivalSchedule: { waves: WAVES, waveSize: ORDER_COUNT / WAVES, delayBetweenWavesMs: WAVE_DELAY_MS }, feeInputs: { maxFeePerGasWei: "2000000000", maxPriorityFeePerGasWei: "1000000000" }, latencyTargetMs: LATENCY_TARGET_MS, percentileMethod: "nearest-rank" },
    runs,
    aggregate,
    selection: { qualifyingSettings: qualifying.map((entry) => entry.settingBlocks), selectedSettingBlocks: selected?.settingBlocks ?? null, miss, missReason: miss ? `no setting met p95 <= ${String(LATENCY_TARGET_MS)} ms` : null, chosenTradeoffSettingBlocks: chosenTradeoff.settingBlocks, chosenTradeoffReason: miss ? "chosen for the lowest p95 when no setting met the latency target; the miss and trade-off are published" : "lowest mean per-success cost among the settings that met p95 <= 240000 ms" },
    passed: runs.length === MAX_CHANNEL_DURATIONS.length * RUNS_PER_SETTING && runs.every((run) => run.completed === ORDER_COUNT && run.failed === 0 && run.batch.txCount > 0) && (selected !== null || miss),
    limitations: [
      `Benchmarks run on ${laneMode}; timestamps are local test-lane values, not production latency.`,
      "Orders are synthetic ETH transfers that follow one fixed arrival schedule; they exercise batch publication and derivation latency, not the full settlement business path.",
      "Batch fill uses the blob-slot definition; calldata compensation and fee-market variability are not modelled.",
    ],
    notes: [
      "Every run retains the raw per-order timestamps and the raw L1 batch transaction receipts.",
      "p50/p95 use the nearest-rank method over all samples in the setting; per-run values are also retained.",
    ],
  };
  writeFileSync(join(evidenceDir, "ops-batch-setting-benchmark.json"), `${json(evidence)}\n`);
  console.log(`wrote evidence/s21/ops-batch-setting-benchmark.json passed=${String(evidence.passed)} selected=${String(selected?.settingBlocks ?? null)} miss=${String(miss)}`);
  if (!evidence.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
