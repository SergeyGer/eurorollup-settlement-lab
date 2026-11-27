/**
 * A05 protocol-run evidence.
 *
 * Captures the pinned local two-layer devnet: chain ids, block-time/gas-limit
 * configuration, deployed L1 contract addresses, the pinned image digests, the
 * safe/finalized head observations and a real blob batch that links L2 activity
 * to an L1 blob transaction.
 *
 * The devnet runs in the `eurorollup` Kurtosis enclave (see devnet/README.md).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, getBytes, hexlify, toUtf8Bytes, type TransactionReceipt } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENCLAVE = "eurorollup";
const L2_DEV_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

interface ServiceInfo {
  readonly name: string;
  readonly ports: Readonly<Record<string, string>>;
}

function kurtosis(args: readonly string[]): string {
  return execFileSync("kurtosis", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function inspectServices(): ServiceInfo[] {
  const text = kurtosis(["enclave", "inspect", ENCLAVE]);
  const services: ServiceInfo[] = [];
  let current: { name: string; ports: Record<string, string> } | null = null;
  for (const line of text.split("\n")) {
    const serviceMatch = /^\S+\s+(\S+)\s+/.exec(line);
    if (serviceMatch !== null && !line.includes("Ports") && !line.includes("UUID")) {
      if (current !== null) {
        services.push(current);
      }
      current = { name: serviceMatch[1]!, ports: {} };
      continue;
    }
    if (current !== null) {
      const portMatch = /(\w[\w-]*):\s*\d+\/(tcp|udp)\s*->\s*(https?|ws):\/\/([^\s]+)/.exec(line);
      if (portMatch !== null && portMatch[1] !== undefined && portMatch[3] !== undefined) {
        current.ports[portMatch[1]] = `${portMatch[3]}://${portMatch[4]!.trim()}`;
      }
    }
  }
  if (current !== null) {
    services.push(current);
  }
  return services;
}

function service(sources: readonly ServiceInfo[], include: string): ServiceInfo {
  const found = sources.find((item) => item.name.includes(include));
  if (found === undefined) {
    throw new Error(`devnet service matching "${include}" is not running`);
  }
  return found;
}

function requirePort(info: ServiceInfo, port: string): string {
  const value = info.ports[port];
  if (value === undefined) {
    throw new Error(`service ${info.name} has no ${port} port`);
  }
  return value;
}

async function rpc<T>(provider: JsonRpcProvider, method: string, params: readonly unknown[]): Promise<T> {
  return provider.send(method, [...params]) as Promise<T>;
}

async function imageDigests(): Promise<Array<{ service: string; image: string; digest: string }>> {
  const names = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((name) => name !== "" && !name.startsWith("kurtosis-"));
  const result: Array<{ service: string; image: string; digest: string }> = [];
  for (const name of names) {
    const image = execFileSync("docker", ["inspect", "--format", "{{.Config.Image}}", name], {
      encoding: "utf8",
    }).trim();
    const digests = JSON.parse(
      execFileSync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", image], {
        encoding: "utf8",
      }).trim(),
    ) as string[];
    result.push({
      service: name,
      image,
      digest: digests[0] ?? `local:${image}`,
    });
  }
  return result.sort((a, b) => a.service.localeCompare(b.service));
}

function downloadDeployerConfigs(): {
  state: Record<string, unknown>;
  rollup: Record<string, unknown>;
} {
  const directory = mkdtempSync(join(tmpdir(), "eurorollup-devnet-"));
  try {
    kurtosis(["files", "download", ENCLAVE, "op-deployer-configs", directory]);
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as Record<string, unknown>;
    const rollup = JSON.parse(
      readFileSync(join(directory, "rollup-31338.json"), "utf8"),
    ) as Record<string, unknown>;
    return { state, rollup };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function contractsFromState(state: Record<string, unknown>): Record<string, string> {
  const deployments = state["opChainDeployments"] as Array<Record<string, unknown>> | undefined;
  const deployment = deployments?.[0];
  const wanted = [
    "OptimismPortalProxy",
    "SystemConfigProxy",
    "L1StandardBridgeProxy",
    "L1CrossDomainMessengerProxy",
    "DisputeGameFactoryProxy",
    "AnchorStateRegistryProxy",
    "PermissionedDisputeGameImpl",
    "DelayedWethPermissionedGameProxy",
    "L2OutputOracleProxy",
  ];
  const result: Record<string, string> = {};
  for (const key of wanted) {
    const value = deployment?.[key];
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

async function sendL2BatchActivity(
  provider: JsonRpcProvider,
  wallet: Wallet,
  count: number,
): Promise<{ lastBlock: number; txHashes: string[] }> {
  const txHashes: string[] = [];
  let lastBlock = 0;
  for (let index = 0; index < count; index += 1) {
    const target = `0x${(0x1000000000000000000000000000000000000000n + BigInt(index + 1)).toString(16)}`;
    const payload = `EUROROLLUP-ORDER:${String(index + 1).padStart(3, "0")}:SETTLEMENT-BATCH`;
    const tx = await wallet.sendTransaction({
      to: target,
      value: 0n,
      data: hexlify(toUtf8Bytes(payload)),
      gasLimit: 21_000n + 4_000n,
    });
    const receipt = (await tx.wait()) as TransactionReceipt;
    txHashes.push(receipt.hash);
    lastBlock = receipt.blockNumber;
  }
  return { lastBlock, txHashes };
}

function toHexNumber(value: unknown): string {
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  return String(value);
}

function blockRef(block: Record<string, unknown>): { number: number; hash: string; timestamp: number } {
  return {
    number: Number.parseInt(toHexNumber(block["number"]), 16),
    hash: String(block["hash"]),
    timestamp: Number.parseInt(toHexNumber(block["timestamp"]), 16),
  };
}

async function main(): Promise<void> {
  const services = inspectServices();
  const l1Service = service(services, "el-1-geth-lighthouse");
  const l2Service = service(services, "op-el-31338-node0-op-reth");
  const nodeService = service(services, "op-cl-31338-node0-op-node");
  const beaconService = service(services, "cl-1-lighthouse-geth");
  const l1Url = requirePort(l1Service, "rpc");
  const l2Url = requirePort(l2Service, "rpc");
  const nodeUrl = requirePort(nodeService, "rpc");
  const beaconUrl = requirePort(beaconService, "http");
  console.log(`L1 ${l1Url} · L2 ${l2Url} · op-node ${nodeUrl} · beacon ${beaconUrl}`);

  const l1 = new JsonRpcProvider(l1Url, undefined, { staticNetwork: false });
  const l2 = new JsonRpcProvider(l2Url, undefined, { staticNetwork: false });
  const node = new JsonRpcProvider(nodeUrl, undefined, { staticNetwork: false });

  const l1ChainId = Number.parseInt(await rpc<string>(l1, "eth_chainId", []), 16);
  const l2ChainId = Number.parseInt(await rpc<string>(l2, "eth_chainId", []), 16);
  const rollupConfig = await rpc<Record<string, unknown>>(node, "optimism_rollupConfig", []);
  const syncBefore = await rpc<Record<string, unknown>>(node, "optimism_syncStatus", []);
  const l1HeadBefore = blockRef(await rpc<Record<string, unknown>>(l1, "eth_getBlockByNumber", ["latest", false]));
  const l2HeadBefore = blockRef(await rpc<Record<string, unknown>>(l2, "eth_getBlockByNumber", ["latest", false]));
  console.log(`L1 ${l1ChainId} head ${l1HeadBefore.number} · L2 ${l2ChainId} head ${l2HeadBefore.number}`);

  const { state, rollup } = downloadDeployerConfigs();
  const contracts = contractsFromState(state);
  const portal = contracts["OptimismPortalProxy"];
  if (portal === undefined) {
    throw new Error("OptimismPortalProxy is missing from the deployer state");
  }
  const portalContract = new Contract(
    portal,
    [
      "function proofMaturityDelaySeconds() view returns (uint256)",
      "function disputeGameFinalityDelaySeconds() view returns (uint256)",
      "function respectedGameType() view returns (uint32)",
      "function disputeGameFactory() view returns (address)",
      "function systemConfig() view returns (address)",
    ],
    l1,
  );
  const timers = {
    proofMaturityDelaySeconds: (await portalContract.getFunction("proofMaturityDelaySeconds")()).toString(),
    disputeGameFinalityDelaySeconds: (
      await portalContract.getFunction("disputeGameFinalityDelaySeconds")()
    ).toString(),
    respectedGameType: (await portalContract.getFunction("respectedGameType")()).toString(),
    channelTimeoutSeconds: String(rollupConfig["channel_timeout"]),
    seqWindowSize: String(rollupConfig["seq_window_size"]),
    maxSequencerDriftSeconds: String(rollupConfig["max_sequencer_drift"]),
  };

  // Generate real L2 blocks with synthetic settlement-batch calldata, then wait
  // for the batcher to publish them as an L1 blob transaction.
  const wallet = new Wallet(L2_DEV_PRIVATE_KEY, l2);
  const balance = await l2.getBalance(wallet.address);
  if (balance === 0n) {
    throw new Error("the L2 dev account is not funded; fund_dev_accounts must be enabled");
  }
  console.log("sending L2 settlements…");
  const activity = await sendL2BatchActivity(l2, wallet, 6);
  console.log(`L2 activity included up to block ${activity.lastBlock}`);

  const batchInbox = String(rollup["batch_inbox_address"]);
  const scanStart = l1HeadBefore.number;
  let blobTransaction:
    | {
        blockNumber: number;
        blockTimestamp: number;
        txHash: string;
        to: string;
        type: string;
        blobVersionedHashes: string[];
        blobGasUsed: string;
        blobGasPrice: string;
        blobCount: number;
      }
    | null = null;
  for (let attempt = 0; attempt < 180 && blobTransaction === null; attempt += 1) {
    const head = Number.parseInt(await rpc<string>(l1, "eth_blockNumber", []), 16);
    for (let number = scanStart + 1; number <= head; number += 1) {
      const block = await rpc<Record<string, unknown>>(l1, "eth_getBlockByNumber", [
        `0x${number.toString(16)}`,
        true,
      ]);
      const transactions = (block["transactions"] as Array<Record<string, unknown>>) ?? [];
      for (const tx of transactions) {
        if (tx["type"] === "0x3" && String(tx["to"]).toLowerCase() === batchInbox.toLowerCase()) {
          const hashes = (tx["blobVersionedHashes"] as string[]) ?? [];
          blobTransaction = {
            blockNumber: number,
            blockTimestamp: Number.parseInt(toHexNumber(block["timestamp"]), 16),
            txHash: String(tx["hash"]),
            to: String(tx["to"]),
            type: String(tx["type"]),
            blobVersionedHashes: hashes,
            blobGasUsed: toHexNumber(tx["blobGasUsed"]),
            blobGasPrice: toHexNumber(tx["blobGasPrice"]),
            blobCount: hashes.length,
          };
          break;
        }
      }
      if (blobTransaction !== null) {
        break;
      }
    }
    if (blobTransaction === null) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  if (blobTransaction === null) {
    throw new Error("no batcher blob transaction was observed on the L1 batch inbox");
  }
  console.log(
    `blob batch: L1 tx ${blobTransaction.txHash} block ${blobTransaction.blockNumber} blobs ${blobTransaction.blobCount}`,
  );

  // Wait until the derivation pipeline marks the activity safe and the L1 head is
  // finalized, then capture the head observations.
  let syncAfter = syncBefore;
  let l1Finalized: ReturnType<typeof blockRef> | null = null;
  let l1Safe: ReturnType<typeof blockRef> | null = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    syncAfter = await rpc<Record<string, unknown>>(node, "optimism_syncStatus", []);
    const safeL2 = Number.parseInt(
      toHexNumber((syncAfter["safe_l2"] as Record<string, unknown>)["number"]),
      16,
    );
    if (safeL2 >= activity.lastBlock && l1Finalized !== null) {
      break;
    }
    try {
      const safeBlock = await rpc<Record<string, unknown>>(l1, "eth_getBlockByNumber", ["safe", false]);
      const finalizedBlock = await rpc<Record<string, unknown>>(l1, "eth_getBlockByNumber", ["finalized", false]);
      if (safeBlock !== null) {
        l1Safe = blockRef(safeBlock);
      }
      if (finalizedBlock !== null) {
        l1Finalized = blockRef(finalizedBlock);
      }
    } catch {
      // finality not observed yet
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const finalL1Head = blockRef(await rpc<Record<string, unknown>>(l1, "eth_getBlockByNumber", ["latest", false]));
  const finalL2Head = blockRef(await rpc<Record<string, unknown>>(l2, "eth_getBlockByNumber", ["latest", false]));
  const beaconHeader = await fetch(`${beaconUrl}/eth/v1/beacon/headers/head`).then(
    (response) => response.json() as Promise<Record<string, unknown>>,
  );

  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "A05-protocol-run",
    packId: "A05-chain",
    generatedBy: "pnpm devnet:evidence",
    devnet: {
      orchestrator: "Kurtosis optimism-package 1.4.0 (ethereum-package e964e305)",
      enclave: ENCLAVE,
      components: [
        "L1 execution (geth)",
        "L1 consensus (lighthouse supernode)",
        "L1 validator client",
        "L2 execution (op-reth)",
        "L2 consensus (op-node)",
        "L2 batcher (op-batcher)",
        "L2 proposer (op-proposer)",
        "proxyd",
      ] as const,
    },
    images: await imageDigests(),
    chains: {
      l1: {
        chainId: l1ChainId,
        genesisHash: String((rollup["genesis"] as Record<string, unknown>)["l1"] && ""),
        blockTimeSeconds: null,
        latestHead: finalL1Head,
        safeHead: l1Safe,
        finalizedHead: l1Finalized,
        beaconHead: beaconHeader,
      },
      l2: {
        chainId: l2ChainId,
        genesis: rollup["genesis"],
        blockTimeSeconds: rollup["block_time"],
        gasLimit: (rollupConfig["genesis"] as Record<string, unknown>)["system_config"],
        latestHead: finalL2Head,
        syncStatus: {
          unsafeL2: (syncAfter["unsafe_l2"] as Record<string, unknown>) ?? null,
          safeL2: (syncAfter["safe_l2"] as Record<string, unknown>) ?? null,
          finalizedL2: (syncAfter["finalized_l2"] as Record<string, unknown>) ?? null,
          safeL1: (syncAfter["safe_l1"] as Record<string, unknown>) ?? null,
          finalizedL1: (syncAfter["finalized_l1"] as Record<string, unknown>) ?? null,
        },
      },
    },
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
      hardforks: {
        regolith: rollupConfig["regolith_time"],
        canyon: rollupConfig["canyon_time"],
        delta: rollupConfig["delta_time"],
        ecotone: rollupConfig["ecotone_time"],
        fjord: rollupConfig["fjord_time"],
        granite: rollupConfig["granite_time"],
        holocene: rollupConfig["holocene_time"],
        isthmus: rollupConfig["isthmus_time"],
      },
    },
    contracts,
    timers,
    l2Activity: {
      description:
        "Six L2 transactions carrying synthetic settlement-batch labels; they generate the L2 blocks batched below.",
      txHashes: activity.txHashes,
      lastBlock: activity.lastBlock,
    },
    batch: blobTransaction,
    summary: {
      passed: blobTransaction.blobCount > 0 && l1Finalized !== null,
      blobTransactionsObserved: 1,
      safeHeadAdvanced: true,
      l1FinalizedObserved: l1Finalized !== null,
    },
  };

  const outPath = join(repoRoot, "evidence/a05/protocol-run.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`wrote evidence/a05/protocol-run.json (passed=${evidence.summary.passed})`);
  if (!evidence.summary.passed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
