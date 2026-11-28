/**
 * S19 / NET-01 independent deriving verifier.
 *
 * Starts a second op-reth + op-node pair from the lane's committed rollup/genesis configs
 * on separate ports, lets it derive the L2 chain from the same L1 blobs, and compares the
 * activity block hash with the sequencer. The result is merged into
 * evidence/s19/net01-lane.json under derivation.derivingVerifier.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = join(repoRoot, "evidence", "s19", "net01-lane.json");
const workDir = join(repoRoot, "tmp-s19", "verifier");
const ENCLAVE = process.env.NET01_ENCLAVE ?? "net01g";
const L1_URL = process.env.NET01_L1_RPC;
const BEACON_URL = process.env.NET01_BEACON_URL;
const SEQUENCER_URL = process.env.NET01_L2_RPC;
const image = {
  opReth: "us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.4.0",
  opNode: "us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.3",
};
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}
function removeContainer(name: string): void {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}
async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await condition()) return;
    } catch {
      // engine still starting
    }
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  if (L1_URL === undefined || BEACON_URL === undefined || SEQUENCER_URL === undefined) throw new Error("NET01_L1_RPC, NET01_BEACON_URL and NET01_L2_RPC are required");
  mkdirSync(workDir, { recursive: true });
  for (const artifact of ["op-deployer-configs", "op_jwt_file", "el_cl_genesis_data"]) {
    const target = join(workDir, artifact === "op-deployer-configs" ? "configs" : artifact === "op_jwt_file" ? "jwt" : "l1");
    execFileSync("kurtosis", ["files", "download", ENCLAVE, artifact, target], { stdio: "ignore" });
  }
  // op-node v1.19.3 rejects the newer geth `terminalTotalDifficultyPassed` field in the
  // L1 chain config; strip it for the deriving verifier only.
  const l1GenesisPath = join(workDir, "l1", "genesis.json");
  if (existsSync(l1GenesisPath)) {
    const l1Genesis = JSON.parse(readFileSync(l1GenesisPath, "utf8")) as Record<string, any>;
    if (l1Genesis["config"] !== undefined) delete (l1Genesis["config"] as Record<string, unknown>)["terminalTotalDifficultyPassed"];
    writeFileSync(join(workDir, "l1-clean.json"), `${JSON.stringify(l1Genesis, null, 2)}\n`);
  }
  const jwtPath = existsSync(join(workDir, "jwt", "jwtsecret")) ? join(workDir, "jwt", "jwtsecret") : join(workDir, "jwt", "jwt.txt");
  const genesisPath = join(workDir, "configs", "genesis-16584.json");
  const rollupPath = join(workDir, "configs", "rollup-16584.json");
  if (!existsSync(jwtPath) || !existsSync(genesisPath) || !existsSync(rollupPath)) throw new Error("verifier configs are incomplete");

  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, any>;
  const activityBlock = Number(evidence["activity"]["lastBlock"]);
  const sequencerBlock = (await rpc(SEQUENCER_URL, "eth_getBlockByNumber", [`0x${activityBlock.toString(16)}`, false])) as Record<string, any>;
  const sequencerHash = String(sequencerBlock["hash"]);

  removeContainer("net01-verifier-reth");
  removeContainer("net01-verifier-node");
  docker(["run", "-d", "--name", "net01-verifier-reth", "--network", "host", "-v", `${workDir}:/workspace`, image.opReth, "node", "--chain=/workspace/configs/genesis-16584.json", "--datadir=/workspace/reth-data", "--http", "--http.addr=127.0.0.1", "--http.port=9545", "--http.api=eth,net,web3,debug", "--authrpc.addr=127.0.0.1", "--authrpc.port=9546", "--authrpc.jwtsecret=/workspace/jwt/jwtsecret", "--rollup.disable-tx-pool-gossip"]);
  const provider = new JsonRpcProvider("http://127.0.0.1:9545", undefined, { staticNetwork: true });
  await waitFor(async () => (await provider.getBlockNumber()) >= 0, 120_000, "verifier op-reth");
  docker(["run", "-d", "--name", "net01-verifier-node", "--network", "host", "-v", `${workDir}:/workspace`, image.opNode, "op-node", `--l1=${L1_URL}`, `--l1.beacon=${BEACON_URL}`, "--l2=http://127.0.0.1:9546", "--l2.jwt-secret=/workspace/jwt/jwtsecret", "--l2.enginekind=reth", "--rollup.config=/workspace/configs/rollup-16584.json", "--rollup.l1-chain-config=/workspace/l1-clean.json", "--sequencer.enabled=false", "--verifier.l1-confs=1", "--rpc.addr=127.0.0.1", "--rpc.port=9548", "--p2p.listen.ip=127.0.0.1", "--p2p.listen.tcp=9223", "--p2p.listen.udp=9223", "--p2p.advertise.ip=127.0.0.1", "--p2p.advertise.tcp=9223", "--p2p.advertise.udp=9223", "--log.level=info"]);
  const verifierNode = "http://127.0.0.1:9548";
  await waitFor(async () => {
    const status = (await rpc(verifierNode, "optimism_syncStatus")) as Record<string, any>;
    return Number(status["safe_l2"]?.["number"] ?? 0) >= activityBlock;
  }, 600_000, `verifier safe head >= ${String(activityBlock)}`);
  const verifierStatus = (await rpc(verifierNode, "optimism_syncStatus")) as Record<string, any>;
  const verifierBlock = (await provider.getBlock(activityBlock)) as Record<string, any> | null;
  const verifierHash = String(verifierBlock?.["hash"] ?? "");
  const match = verifierHash.toLowerCase() === sequencerHash.toLowerCase();
  const result = {
    method: "independent op-reth + op-node verifier started from the lane's rollup/genesis configs",
    images: image,
    endpoints: { verifierL2Rpc: "http://127.0.0.1:9545", verifierNodeRpc: verifierNode, sequencerL2Rpc: SEQUENCER_URL, l1: L1_URL, beacon: BEACON_URL },
    configDigests: {
      genesis: createHash("sha256").update(readFileSync(genesisPath)).digest("hex"),
      rollup: createHash("sha256").update(readFileSync(rollupPath)).digest("hex"),
    },
    activityBlock,
    sequencerBlockHash: sequencerHash,
    verifierBlockHash: verifierHash,
    match,
    verifierHeads: { unsafe: verifierStatus["unsafe_l2"], safe: verifierStatus["safe_l2"], finalized: verifierStatus["finalized_l2"] },
    matchedAt: new Date().toISOString(),
    passed: match,
  };
  evidence["derivation"]["derivingVerifier"] = result;
  evidence["passed"] = evidence["passed"] === true && match;
  writeFileSync(evidencePath, `${json(evidence)}\n`);
  console.log(`deriving verifier: activity block ${String(activityBlock)} sequencer=${sequencerHash.slice(0, 12)}… verifier=${verifierHash.slice(0, 12)}… match=${String(match)}`);
  removeContainer("net01-verifier-node");
  removeContainer("net01-verifier-reth");
  if (!match) process.exitCode = 1;
}

main().catch((error: unknown) => {
  removeContainer("net01-verifier-node");
  removeContainer("net01-verifier-reth");
  console.error(error);
  process.exitCode = 1;
});
