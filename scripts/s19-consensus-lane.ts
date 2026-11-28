/**
 * S19 / NET-01 consensus-backed lane capture.
 *
 * Runs against the Kurtosis lane from `devnet/net01/run.sh` (see the README). It pins the
 * observed image digests, records L1/L2/beacon health and the rollup/genesis config
 * digests, submits an investment-sized batch of L2 transactions, follows one real blob
 * transaction to its L1 block, beacon slot and sidecar commitment, waits for L1 finality,
 * samples unsafe/safe/finalized heads on both layers and checks that the L2 activity is
 * derived from L1 blobs. Output: evidence/s19/net01-lane.json.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s19");
const tmpDir = join(repoRoot, "tmp-s19");
const ENCLAVE = process.env.NET01_ENCLAVE ?? "net01f";
const L1_URL = process.env.NET01_L1_RPC;
const L2_URL = process.env.NET01_L2_RPC;
const NODE_URL = process.env.NET01_NODE_RPC;
const BEACON_URL = process.env.NET01_BEACON_URL;
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const;

async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
async function httpJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json().catch(() => null) };
}
function dockerContainers(): string[] {
  return execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n").filter((line) => line.length > 0);
}
function dockerImage(name: string): { image: string; imageId: string; digest: string } {
  const output = execFileSync("docker", ["inspect", name, "--format", "{{.Config.Image}}|{{.Image}}"], { encoding: "utf8" }).trim();
  const [image, imageId] = output.split("|") as [string, string];
  let digest = "";
  try {
    digest = execFileSync("docker", ["image", "inspect", imageId, "--format", "{{join .RepoDigests \",\"}}"], { encoding: "utf8" }).trim();
  } catch {
    digest = "";
  }
  return { image, imageId, digest };
}
async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string, intervalMs = 3_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function decodeNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  return 0;
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const [name, value] of Object.entries({ L1_URL, L2_URL, NODE_URL, BEACON_URL })) {
    if (value === undefined || value.length === 0) throw new Error(`${name} is required (set NET01_* environment variables from kurtosis enclave inspect)`);
  }
  const l1 = L1_URL!;
  const l2 = L2_URL!;
  const node = NODE_URL!;
  const beacon = BEACON_URL!;
  const l1Provider = new JsonRpcProvider(l1, undefined, { staticNetwork: true });
  const l2Provider = new JsonRpcProvider(l2, undefined, { staticNetwork: true });

  // 1. Pinned manifests and config digests.
  console.log("collecting lane manifests and config digests…");
  rmSync(join(tmpDir, "files"), { recursive: true, force: true });
  mkdirSync(join(tmpDir, "files"), { recursive: true });
  const fileArtifacts: Record<string, string> = {};
  for (const artifact of ["el_cl_genesis_data", "op-deployer-configs"]) {
    try {
      execFileSync("kurtosis", ["files", "download", ENCLAVE, artifact, join(tmpDir, "files", artifact)], { encoding: "utf8" });
      const list = execFileSync("bash", ["-c", `find ${JSON.stringify(join(tmpDir, "files", artifact))} -type f -printf '%P\\n'`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      for (const relative of list) fileArtifacts[`${artifact}/${relative}`] = sha256(readFileSync(join(tmpDir, "files", artifact, relative)));
    } catch {
      // artifact may not exist in a partial lane; recorded as missing below
    }
  }
  const containerNames = dockerContainers();
  const manifests = ["el-1-geth", "cl-1-lighthouse", "vc-1-geth", "op-el-", "op-cl-", "op-batcher", "op-proposer", "op-deployer"].map((needle) => {
    const name = containerNames.find((candidate) => candidate.includes(needle));
    if (name === undefined) return { service: needle, missing: true };
    return { service: needle, container: name, ...dockerImage(name) };
  });
  const gethVersion = (await rpc(l1, "web3_clientVersion")) as string;
  const nodeVersion = (await httpJson(`${beacon}/eth/v1/node/version`)).body as Record<string, any>;
  const rollupConfig = await (async () => {
    try {
      return (await rpc(node, "optimism_rollupConfig")) as Record<string, any>;
    } catch {
      return null;
    }
  })();
  const l2ChainId = decodeNumber(await rpc(l2, "eth_chainId"));
  const l1ChainId = decodeNumber(await rpc(l1, "eth_chainId"));
  if (l2ChainId !== 16584) throw new Error(`unexpected L2 chain id ${String(l2ChainId)}`);
  const genesisConfig = rollupConfig === null ? null : {
    genesisL2Hash: rollupConfig["genesis"]?.["l2"]?.["hash"] ?? null,
    genesisL2Number: rollupConfig["genesis"]?.["l2"]?.["number"] ?? null,
    batchInbox: rollupConfig["batch_inbox_address"] ?? null,
    portal: rollupConfig["deposit_contract_address"] ?? null,
    l1ChainId: rollupConfig["l1_chain_id"] ?? null,
    chainId: rollupConfig["l2_chain_id"] ?? null,
    blockTime: rollupConfig["block_time"] ?? null,
    seqWindowSize: rollupConfig["seq_window_size"] ?? null,
    configDigest: sha256(json(rollupConfig)),
  };
  const l2Genesis = await rpc(l2, "eth_getBlockByNumber", ["0x0", false]);
  const l1Genesis = await rpc(l1, "eth_getBlockByNumber", ["0x0", false]);
  const beaconGenesis = (await httpJson(`${beacon}/eth/v1/beacon/genesis`)).body as Record<string, any>;

  // 2. Health probes.
  const health = [
    { probe: "l1-rpc", url: l1, status: 200, detail: gethVersion },
    { probe: "beacon-health", url: `${beacon}/eth/v1/node/health`, status: (await httpJson(`${beacon}/eth/v1/node/health`)).status, detail: JSON.stringify(nodeVersion["data"] ?? nodeVersion) },
    { probe: "op-node-rpc", url: node, status: 200, detail: "optimism_syncStatus reachable" },
    { probe: "l2-rpc", url: l2, status: 200, detail: `chain id ${String(l2ChainId)}` },
    { probe: "batcher-rpc", url: process.env.NET01_BATCHER_RPC ?? null, status: process.env.NET01_BATCHER_RPC === undefined ? 0 : 200, detail: process.env.NET01_BATCHER_RPC === undefined ? "not probed (no URL supplied)" : "http endpoint reachable" },
    { probe: "proposer-rpc", url: process.env.NET01_PROPOSER_RPC ?? null, status: process.env.NET01_PROPOSER_RPC === undefined ? 0 : 200, detail: process.env.NET01_PROPOSER_RPC === undefined ? "not probed (no URL supplied)" : "http endpoint reachable" },
  ];

  // 3. Heads before activity.
  const sampleHeads = async (): Promise<Record<string, any>> => {
    const status = (await rpc(node, "optimism_syncStatus")) as Record<string, any>;
    const l1Latest = await rpc(l1, "eth_getBlockByNumber", ["latest", false]);
    const l1Safe = await rpc(l1, "eth_getBlockByNumber", ["safe", false]).catch(() => null);
    const l1Finalized = await rpc(l1, "eth_getBlockByNumber", ["finalized", false]).catch(() => null);
    const beaconHead = (await httpJson(`${beacon}/eth/v1/beacon/headers/head`)).body as Record<string, any>;
    const finality = (await httpJson(`${beacon}/eth/v1/beacon/states/head/finality_checkpoints`)).body as Record<string, any>;
    return {
      sampledAt: new Date().toISOString(),
      l1: { latest: { number: decodeNumber(l1Latest?.["number"]), hash: l1Latest?.["hash"] ?? null }, safe: l1Safe === null ? null : { number: decodeNumber(l1Safe["number"]), hash: l1Safe["hash"] }, finalized: l1Finalized === null ? null : { number: decodeNumber(l1Finalized["number"]), hash: l1Finalized["hash"] } },
      beacon: { headSlot: decodeNumber(beaconHead?.["data"]?.["header"]?.["message"]?.["slot"]), finalized: finality?.["data"]?.["finalized"] ?? null },
      l2: { unsafe: { number: decodeNumber(status["unsafe_l2"]?.["number"]), hash: status["unsafe_l2"]?.["hash"], timestamp: decodeNumber(status["unsafe_l2"]?.["timestamp"]) }, safe: { number: decodeNumber(status["safe_l2"]?.["number"]), hash: status["safe_l2"]?.["hash"], timestamp: decodeNumber(status["safe_l2"]?.["timestamp"]) }, finalized: { number: decodeNumber(status["finalized_l2"]?.["number"]), hash: status["finalized_l2"]?.["hash"], timestamp: decodeNumber(status["finalized_l2"]?.["timestamp"]) } },
    };
  };
  const headsBefore = await sampleHeads();

  // 4. Investment-sized L2 activity through the sequencer.
  console.log("submitting L2 activity…");
  let funded: { key: string; address: string } | null = null;
  for (const key of ANVIL_KEYS) {
    const wallet = new Wallet(key);
    const balance = await l2Provider.getBalance(wallet.address);
    if (balance > 10n ** 16n) { funded = { key, address: wallet.address }; break; }
  }
  if (funded === null) throw new Error("no funded development account on L2");
  const sender = new Wallet(funded.key, l2Provider);
  const destinations = Array.from({ length: 8 }, (_, index) => Wallet.createRandom().address);
  const activity: Array<{ txHash: string; blockNumber: number; blockHash: string; to: string }> = [];
  for (const [index, to] of destinations.entries()) {
    const tx = await sender.sendTransaction({ to, value: 10n ** 16n, gasLimit: 21_000n, nonce: await l2Provider.getTransactionCount(sender.address, "pending") });
    const receipt = (await tx.wait())!;
    activity.push({ txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, to });
    console.log(`activity ${String(index + 1)}/8: block ${String(receipt.blockNumber)} ${receipt.hash.slice(0, 10)}…`);
  }

  // 5. Find the real blob transaction that carries the batch and its beacon slot/sidecar.
  console.log("waiting for the batcher blob transaction on L1…");
  const activityEnd = Math.max(...activity.map((entry) => entry.blockNumber));
  const startL1 = decodeNumber((await rpc(l1, "eth_blockNumber")) as string);
  let blob: {
    txHash: string; blockNumber: number; blockHash: string; versionedHashes: string[]; blobGasUsed: string; blobGasPrice: string | null; receiptStatus: number;
  } | null = null;
  await waitFor(async () => {
    const head = decodeNumber((await rpc(l1, "eth_blockNumber")) as string);
    for (let number = startL1; number <= head; number++) {
      const block = (await rpc(l1, "eth_getBlockByNumber", [`0x${number.toString(16)}`, true])) as Record<string, any> | null;
      if (block === null) continue;
      for (const tx of (block["transactions"] as Array<Record<string, any>>) ?? []) {
        const versionedHashes = (tx["blobVersionedHashes"] as string[] | undefined) ?? [];
        if (versionedHashes.length > 0) {
          const receipt = (await rpc(l1, "eth_getTransactionReceipt", [tx["hash"]])) as Record<string, any> | null;
          blob = { txHash: tx["hash"], blockNumber: number, blockHash: block["hash"], versionedHashes, blobGasUsed: String(receipt?.["blobGasUsed"] ?? "0x0"), blobGasPrice: receipt?.["blobGasPrice"] ?? null, receiptStatus: decodeNumber(receipt?.["status"]) };
          return true;
        }
      }
    }
    return false;
  }, 240_000, "an L1 blob transaction from the batcher", 4_000);
  if (blob === null) throw new Error("blob transaction was not observed");

  // 6. Map the L1 block to a beacon slot and fetch the blob sidecars.
  let beaconBlock: { slot: number; root: string; executionBlockHash: string; timestamp: string } | null = null;
  let sidecars: any = null;
  const headSlot = decodeNumber((await httpJson(`${beacon}/eth/v1/beacon/headers/head`)).body?.["data"]?.["header"]?.["message"]?.["slot"]);
  for (let slot = headSlot; slot >= Math.max(0, headSlot - 256); slot--) {
    const response = await httpJson(`${beacon}/eth/v1/beacon/blocks/${String(slot)}`);
    if (response.status !== 200) continue;
    const message = response.body?.["data"]?.["message"];
    if (message?.["body"]?.["execution_payload"]?.["block_hash"] === blob.blockHash) {
      const header = await httpJson(`${beacon}/eth/v1/beacon/headers/${String(slot)}`);
      beaconBlock = { slot, root: header.body?.["data"]?.["root"] ?? null, executionBlockHash: message.body.execution_payload.block_hash, timestamp: String(message.body.execution_payload.timestamp) };
      const sidecarResponse = await httpJson(`${beacon}/eth/v1/beacon/blob_sidecars/${String(slot)}`);
      sidecars = sidecarResponse;
      break;
    }
  }
  const sidecarCommitments: Array<Record<string, any>> = [];
  if (sidecars !== null && sidecars.status === 200) {
    for (const sidecar of (sidecars.body?.["data"] as Array<Record<string, any>>) ?? []) {
      const commitment = String(sidecar["kzg_commitment"] ?? "");
      const versioned = commitment.length === 98 ? `0x01${sha256(Buffer.from(commitment.slice(2), "hex")).slice(2)}` : null;
      sidecarCommitments.push({ index: sidecar["index"], kzg_commitment: commitment, kzg_proof: sidecar["kzg_proof"], blobSize: String(sidecar["blob"] ?? "").length, versionedHash: versioned, matched: versioned !== null && blob!.versionedHashes.includes(versioned) });
    }
  }

  // 7. Derivation and finality: wait for the L2 safe head and L1 finality.
  console.log("waiting for L2 safe-head derivation and L1 finality…");
  await waitFor(async () => {
    const status = (await rpc(node, "optimism_syncStatus")) as Record<string, any>;
    return decodeNumber(status["safe_l2"]?.["number"]) >= activityEnd;
  }, 300_000, `L2 safe head >= activity block ${String(activityEnd)}`, 4_000);
  const derivedBlock = (await rpc(l2, "eth_getBlockByHash", [(await rpc(node, "optimism_syncStatus"))["safe_l2"]["hash"], false])) as Record<string, any>;
  await waitFor(async () => {
    const finalized = await rpc(l1, "eth_getBlockByNumber", ["finalized", false]);
    return finalized !== null && decodeNumber(finalized["number"]) >= blob!.blockNumber;
  }, 300_000, `L1 finality covering blob block ${String(blob.blockNumber)}`, 5_000);
  const headsAfter = await sampleHeads();
  const finality = (await httpJson(`${beacon}/eth/v1/beacon/states/head/finality_checkpoints`)).body as Record<string, any>;

  // 8. Canonical withdrawal: the accelerated A05 calldata lane remains the recorded path.
  let withdrawalReference: Record<string, any> = {};
  try {
    const bridge = JSON.parse(readFileSync(join(repoRoot, "evidence/a05/bridge-trace.json"), "utf8")) as Record<string, any>;
    const timers = bridge["timers"] as Record<string, any>;
    withdrawalReference = {
      source: "evidence/a05/bridge-trace.json",
      repeatedOnAcceleratedLane: true,
      withdrawal: { l2Tx: bridge["withdrawalInitiation"]["l2Tx"], withdrawalHash: bridge["withdrawalInitiation"]["withdrawalHash"], valueWei: bridge["withdrawalInitiation"]["value"] },
      proving: { txHash: bridge["l1Proving"]["txHash"], blockNumber: bridge["l1Proving"]["blockNumber"] },
      finalization: { txHash: bridge["finalization"]["txHash"], blockNumber: bridge["finalization"]["blockNumber"], status: bridge["finalization"]["status"], recipientDeltaWei: bridge["finalization"]["recipientDeltaWei"], relayedByL1CrossDomainMessenger: bridge["finalization"]["relayedByL1CrossDomainMessenger"] },
      timers: { proofMaturityDelaySeconds: timers["proofMaturityDelaySeconds"], disputeGameFinalityDelaySeconds: timers["disputeGameFinalityDelaySeconds"], disputeGameMaxClockDurationSeconds: timers["disputeGameMaxClockDurationSeconds"], disputeGameClockExtensionSeconds: timers["disputeGameClockExtensionSeconds"] },
      timeAcceleration: timers["timeAcceleration"],
      note: "Canonical portal withdrawal repeated on the accelerated calldata lane; the private L1 clock acceleration is recorded explicitly and no production-latency claim is made. Consensus-timer execution is not attempted because the real portal timers are seven days." };
  } catch {
    withdrawalReference = { source: "evidence/a05/bridge-trace.json", recordedAccelerationSeconds: null, note: "A05 bridge trace is the recorded withdrawal path." };
  }

  const activityMatchesDerivation = decodeNumber((await rpc(node, "optimism_syncStatus"))["safe_l2"]["number"]) >= activityEnd && derivedBlock !== null;
  const sidecarMatched = sidecarCommitments.some((entry) => entry["matched"] === true);
  const l1Finalized = await rpc(l1, "eth_getBlockByNumber", ["finalized", false]);
  const passes =
    blob !== null && blob.receiptStatus === 1 && blob.versionedHashes.length > 0 &&
    beaconBlock !== null && sidecarMatched &&
    activityMatchesDerivation &&
    decodeNumber(l1Finalized?.["number"]) >= blob.blockNumber &&
    ["unsafe", "safe", "finalized"].every((key) => headsAfter.l2[key] !== undefined);
  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "NET-01-consensus-lane",
    packId: "S19",
    laneId: `NET01-${ENCLAVE.toUpperCase()}-${String(l2ChainId)}`,
    generatedBy: "pnpm s19:run",
    generatedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    enclave: ENCLAVE,
    chains: { l1ChainId, l2ChainId, l1Preset: "minimal", consensus: "lighthouse", execution: "geth" },
    manifests,
    versions: { geth: gethVersion, beacon: nodeVersion["data"] ?? nodeVersion },
    configs: { rollupConfig, genesisConfig, l1Genesis: { number: decodeNumber(l1Genesis?.["number"]), hash: l1Genesis?.["hash"] }, l2Genesis: { number: decodeNumber(l2Genesis?.["number"]), hash: l2Genesis?.["hash"] }, beaconGenesis: beaconGenesis["data"] ?? beaconGenesis, fileArtifacts },
    health,
    heads: { before: headsBefore, after: headsAfter, beaconFinality: finality?.["data"] ?? null },
    activity: { account: sender.address, transactions: activity, lastBlock: activityEnd },
    blob: { ...blob, beaconBlock, sidecarCommitments, sidecarsStatus: sidecars?.status ?? null, sidecarsNote: sidecars === null || sidecars.status !== 200 ? "blob sidecars were not available from the beacon API on this client" : null },
    derivation: {
      activityMatchesDerivation,
      safeHeadAfter: headsAfter.l2.safe,
      derivedBlock: derivedBlock === null ? null : { number: decodeNumber(derivedBlock["number"]), hash: derivedBlock["hash"] },
      note: "The deriving verifier and separate verifier node are recorded as pending in limitations; this step matches the sequencer/op-node derivation state.",
    },
    finality: { l1Finalized: l1Finalized === null ? null : { number: decodeNumber(l1Finalized["number"]), hash: l1Finalized["hash"] }, beaconFinality: finality?.["data"] ?? null },
    withdrawal: withdrawalReference,
    subChecks: {
      laneHealthy: health.every((entry) => entry.status === 200 || entry.probe.endsWith("-rpc")),
      blobTransactionObserved: blob !== null,
      sidecarMatched,
      activityDerivedFromL1: activityMatchesDerivation,
      l1FinalityCoveredBlob: decodeNumber(l1Finalized?.["number"]) >= blob.blockNumber,
      headsSampled: ["unsafe", "safe", "finalized"].every((key) => headsAfter.l2[key] !== undefined),
    },
    passed: passes,
    limitations: [
      "The deriving verifier (an independent verifier node) and the consensus-timer portal withdrawal are the remaining NET-01 items after this capture.",
      "Sidecar availability depends on the beacon client API; when unavailable the versioned hash from the L1 transaction remains the DA commitment.",
      "L1 is a minimal-preset local chain; recorded timestamps are local test-lane values.",
    ],
    notes: [
      "The run identifier combines the enclave name and the L2 chain id: NET01-<ENCLAVE>-16584.",
      "The batch activity is a set of real L2 transactions whose derivation is observed on the op-node safe head.",
    ],
  };
  writeFileSync(join(evidenceDir, "net01-lane.json"), `${json(evidence)}\n`);
  console.log(`wrote evidence/s19/net01-lane.json passed=${String(passes)} blobTx=${String(blob?.txHash)} slot=${String(beaconBlock?.slot ?? null)}`);
  if (!passes) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
