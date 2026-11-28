/**
 * S20 / LED-01 canonical reconciliation and reorg recovery drill.
 *
 * Runs a controlled anvil chain (chain id 16584) with the settlement contracts, reserves
 * and allocates a fund order in one branch, replaces those blocks with `anvil_reorg`,
 * reserves/allocates a replacement order, and drives the canonical reconciliation ledger
 * through the reorg: exact-block-hash balance reads (EIP-1898), noncanonical-anchor
 * rejection, orphan marking, rewind to the common ancestor, replacement replay, duplicate
 * delivery, interrupted restart and per-asset conservation. Output:
 * evidence/s20/reconciliation-reorg.json.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  CanonicalReconciliationLedger,
  NonCanonicalAnchorError,
  type BalanceObservation,
  type LedgerCheckpoint,
  type LedgerEvent,
  type LedgerSnapshot,
} from "../packages/economics/src/canonical-ledger.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s20");
const anvilBin = process.env.ANVIL_BIN ?? join(process.env.HOME ?? "", ".foundry", "bin", "anvil");
const RPC = "http://127.0.0.1:8610";
const CHAIN_ID = 16584;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CASH = 1_000_000n;
const SPOT = 1_000_000_000_000_000_000n;
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
async function callAtHash(to: string, data: string, blockHash: string): Promise<string> {
  // EIP-1898: the block parameter carries the exact hash, not a number that may be
  // re-pointed by a reorg.
  const result = await rpc("eth_call", [{ to, data }, { blockHash }]);
  return String(result);
}
function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8")) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}
function eventId(txHash: string, logIndex: number): string {
  return `${txHash}:${String(logIndex)}`;
}
function hex(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  if (!existsSync(anvilBin)) throw new Error(`anvil not found at ${anvilBin}`);
  let anvil: ChildProcess | undefined;
  const evidence: Record<string, any> = { schemaVersion: "1.0.0", reportId: "S20-reconciliation-reorg", packId: "S20", generatedBy: "pnpm s20:run", generatedAt: new Date().toISOString() };
  try {
    anvil = spawn(anvilBin, ["--port", "8610", "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
    const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
    const started = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { return await provider.getBlockNumber(); } catch { await sleep(100); }
      }
      throw new Error("anvil did not start");
    })();
    if (started !== 0) throw new Error("port 8610 is already used by a running anvil instance; stop it first");
    console.log(`anvil started at block ${String(started)}`);
    const deployerWallet = new Wallet(DEPLOYER_KEY, provider);
    const deployer = new NonceManager(deployerWallet);
    const investor = new Wallet(keccak256(toUtf8Bytes("s20-investor")), provider);
    const issuer = new Wallet(keccak256(toUtf8Bytes("s20-issuer")), provider);
    const dealer = new Wallet(keccak256(toUtf8Bytes("s20-dealer")), provider);
    const fee = new Wallet(keccak256(toUtf8Bytes("s20-fee")), provider);
    console.log("funding actor wallets…");
    for (const [index, wallet] of [investor, issuer, dealer, fee].entries()) {
      console.log(`funding ${String(index)} ${wallet.address} deployerNonce=${String(await provider.getTransactionCount(deployerWallet.address, "pending"))}`);
      await (await deployer.sendTransaction({ to: wallet.address, value: 10n ** 18n })).wait();
    }
    console.log("deploying contracts…");
    const deploy = async (name: string, args: readonly unknown[]): Promise<Record<string, any>> => {
      const artifact = loadArtifact(name);
      const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
      const contract = (await factory.deploy(...args)) as unknown as Record<string, any>;
      await contract.deploymentTransaction().wait();
      return contract;
    };
    const cash = await deploy("Token", ["Demo euro cash", "dEUR", 6]);
    const spot = await deploy("Token", ["Test wrapped ETH", "tWETH", 18]);
    const fund = await deploy("RestrictedShare", ["Fictional euro fund unit", "eFUND", 6, deployerWallet.address]);
    const escrow = await deploy("Escrow", [await cash.getAddress()]);
    const settlement = await deploy("DvPSettlement", [await cash.getAddress(), await spot.getAddress(), await fund.getAddress(), await escrow.getAddress(), fee.address, issuer.address]);
    const settlementAddress = await settlement.getAddress();
    const escrowAddress = await escrow.getAddress();
    const cashAddress = await cash.getAddress();
    const spotAddress = await spot.getAddress();
    const fundAddress = await fund.getAddress();
    await (await escrow.setOperator(settlementAddress)).wait();
    await (await fund.setMinter(settlementAddress, true)).wait();
    await (await cash.mint(investor.address, 1_000n * CASH)).wait();
    await (await cash.mint(issuer.address, 500n * CASH)).wait();
    await (await spot.mint(dealer.address, SPOT)).wait();
    await (await cash.connect(investor).approve(settlementAddress, 2n ** 255n)).wait();
    await (await cash.connect(investor).approve(escrowAddress, 2n ** 255n)).wait();
    await (await spot.connect(dealer).approve(settlementAddress, 2n ** 255n)).wait();

    const initialState = async (blockNumber: number): Promise<{ block: Record<string, any>; balances: BalanceObservation[]; supplies: BalanceObservation[] }> => {
      const block = (await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false])) as Record<string, any>;
      const blockHash = block["hash"];
      const balanceOf = async (contract: any, account: string): Promise<string> => String(BigInt(await callAtHash(await contract.getAddress(), contract.interface.encodeFunctionData("balanceOf", [account]), blockHash)));
      const totalSupply = async (contract: any): Promise<string> => String(BigInt(await callAtHash(await contract.getAddress(), contract.interface.encodeFunctionData("totalSupply", []), blockHash)));
      const balances: BalanceObservation[] = [];
      for (const [label, wallet] of [["investor", investor], ["issuer", issuer], ["dealer", dealer], ["fee", fee]] as const) {
        balances.push({ account: label, assetId: "dEUR", amountBase: await balanceOf(cash, wallet.address) });
        balances.push({ account: label, assetId: "tWETH", amountBase: await balanceOf(spot, wallet.address) });
        balances.push({ account: label, assetId: "eFUND", amountBase: await balanceOf(fund, wallet.address) });
      }
      balances.push({ account: "escrow", assetId: "dEUR", amountBase: await balanceOf(cash, escrowAddress) });
      balances.push({ account: "escrow", assetId: "tWETH", amountBase: "0" });
      balances.push({ account: "escrow", assetId: "eFUND", amountBase: "0" });
      const supplies: BalanceObservation[] = [
        { account: "totalSupply", assetId: "dEUR", amountBase: await totalSupply(cash) },
        { account: "totalSupply", assetId: "tWETH", amountBase: await totalSupply(spot) },
        { account: "totalSupply", assetId: "eFUND", amountBase: await totalSupply(fund) },
      ];
      return { block: { number: Number(block["number"]), hash: blockHash, parentHash: block["parentHash"] }, balances, supplies };
    };

    const labelOf = new Map<string, string>([
      [investor.address.toLowerCase(), "investor"],
      [issuer.address.toLowerCase(), "issuer"],
      [dealer.address.toLowerCase(), "dealer"],
      [fee.address.toLowerCase(), "fee"],
      [escrowAddress.toLowerCase(), "escrow"],
    ]);
    const escrowInterface = new Contract(escrowAddress, loadArtifact("Escrow").abi).interface;
    const settlementInterface = new Contract(settlementAddress, loadArtifact("DvPSettlement").abi).interface;
    const snapshotFor = async (blockNumber: number): Promise<LedgerSnapshot> => {
      const block = (await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, true])) as Record<string, any>;
      const logs = (await rpc("eth_getLogs", [{ fromBlock: `0x${blockNumber.toString(16)}`, toBlock: `0x${blockNumber.toString(16)}` }])) as Array<Record<string, any>>;
      const events: LedgerEvent[] = [];
      for (const [index, log] of logs.entries()) {
        let parsed: { name: string; args: Record<string, any> } | null = null;
        try {
          const result = escrowInterface.parseLog({ topics: log["topics"], data: log["data"] });
          if (result !== null) parsed = { name: result.name, args: result.args as unknown as Record<string, any> };
        } catch { /* not escrow */ }
        if (parsed === null) {
          try {
            const result = settlementInterface.parseLog({ topics: log["topics"], data: log["data"] });
            if (result !== null) parsed = { name: result.name, args: result.args as unknown as Record<string, any> };
          } catch { /* not settlement */ }
        }
        if (parsed === null) continue;
        const args = parsed.args;
        if (parsed.name === "Reserved") {
          events.push({ eventId: eventId(log["transactionHash"], Number(log["logIndex"])), kind: "RESERVE", orderId: hex(args["orderId"]), blockHash: block["hash"], blockNumber, txHash: log["transactionHash"], logIndex: Number(log["logIndex"]), account: "investor", counterparty: "escrow", assetId: "dEUR", amountBase: String(args["amount"]), feeBase: "0", unitsBase: "0", unitsAssetId: "eFUND" });
        } else if (parsed.name === "Released") {
          events.push({ eventId: eventId(log["transactionHash"], Number(log["logIndex"])), kind: "RELEASE", orderId: hex(args["orderId"]), blockHash: block["hash"], blockNumber, txHash: log["transactionHash"], logIndex: Number(log["logIndex"]), account: "escrow", counterparty: labelOf.get(hex(args["recipient"]).toLowerCase()) ?? hex(args["recipient"]), assetId: "dEUR", amountBase: String(args["amount"]), feeBase: "0", unitsBase: "0", unitsAssetId: "eFUND" });
        } else if (parsed.name === "FundAllocated") {
          events.push({ eventId: eventId(log["transactionHash"], Number(log["logIndex"])), kind: "ALLOCATE", orderId: hex(args["orderId"]), blockHash: block["hash"], blockNumber, txHash: log["transactionHash"], logIndex: Number(log["logIndex"]), account: "investor", counterparty: null, assetId: "eFUND", amountBase: "0", feeBase: "0", unitsBase: String(args["units"]), unitsAssetId: "eFUND" });
        }
      }
      return { blockNumber, blockHash: block["hash"], parentHash: block["parentHash"], events };
    };

    const base = await initialState(await provider.getBlockNumber());
    const initialCheckpoint = CanonicalReconciliationLedger.initialCheckpoint(base.block.number, base.block.hash, base.balances);
    const canonicalHash = async (blockNumber: number): Promise<string> => {
      const block = (await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false])) as Record<string, any>;
      return block["hash"];
    };

    // Branch A: reserve and allocate order A.
    const orderA = keccak256(toUtf8Bytes("S20-ORDER-A"));
    await (await settlement.reserveFund(orderA, investor.address, 300n * CASH)).wait();
    const blockA1 = await provider.getBlockNumber();
    await (await settlement.allocateFund(orderA, investor.address, 3_125_000n, 300n * CASH)).wait();
    const blockA2 = await provider.getBlockNumber();
    const branchA = [await snapshotFor(blockA1), await snapshotFor(blockA2)];
    const orphanHashes = branchA.map((snapshot) => snapshot.blockHash);

    // Index branch A while it is still canonical, then record the projection that the reorg
    // has to rewind.
    const ledger = CanonicalReconciliationLedger.fromCheckpoint(initialCheckpoint);
    const branchAHashes = new Map<number, string>();
    for (const snapshot of branchA) {
      const hash = await canonicalHash(snapshot.blockNumber);
      branchAHashes.set(snapshot.blockNumber, hash);
      ledger.applySnapshot(snapshot, hash);
    }
    const previousProjection = ledger.projection();

    // Controlled reorg: replace the two branch blocks with new empty blocks. The operator
    // nonce is rolled back with the orphaned blocks, so reset the local nonce manager.
    await rpc("anvil_reorg", [2, []]);
    deployer.reset();
    const afterReorgHeight = await provider.getBlockNumber();
    if (afterReorgHeight !== blockA2) throw new Error(`unexpected height after reorg: ${String(afterReorgHeight)} vs ${String(blockA2)}`);
    const orderB = keccak256(toUtf8Bytes("S20-ORDER-B"));
    await (await settlement.reserveFund(orderB, investor.address, 200n * CASH)).wait();
    const blockB1 = await provider.getBlockNumber();
    await (await settlement.allocateFund(orderB, investor.address, 2_000_000n, 200n * CASH)).wait();
    const blockB2 = await provider.getBlockNumber();
    const branchB = [await snapshotFor(blockB1), await snapshotFor(blockB2)];
    const replacementEmptyBlocks = [await snapshotFor(blockA1), await snapshotFor(blockA1 + 1)];
    const replacementBranch = [...replacementEmptyBlocks, ...branchB];
    const replacementHashes = new Map<number, string>();
    for (const snapshot of replacementBranch) replacementHashes.set(snapshot.blockNumber, await canonicalHash(snapshot.blockNumber));

    // Reconcile the reorg to the replacement branch.
    const reorg = ledger.reconcileReorg({
      initialCheckpoint,
      ancestorSnapshots: [],
      previousBranch: branchA,
      replacementBranch,
      expectedCanonicalHash: (snapshot) => replacementHashes.get(snapshot.blockNumber) ?? null,
    });

    // Noncanonical anchor rejection: the orphan block hash is no longer canonical.
    let orphanBalanceRejected = false;
    let orphanBalanceError = "";
    try {
      await callAtHash(cashAddress, new Contract(cashAddress, loadArtifact("Token").abi).interface.encodeFunctionData("balanceOf", [investor.address]), orphanHashes[0]!);
    } catch (error) {
      orphanBalanceRejected = true;
      orphanBalanceError = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
    let anchorRejection = "";
    try {
      ledger.applySnapshot(branchA[0]!, await canonicalHash(branchA[0]!.blockNumber));
    } catch (error) {
      anchorRejection = error instanceof NonCanonicalAnchorError ? `${error.code}: ${error.message}` : String(error);
    }
    if (anchorRejection.length === 0) throw new Error("the orphan anchor was not rejected");

    // Duplicate delivery of the replacement blocks is idempotent.
    let duplicates = 0;
    for (const snapshot of replacementBranch) duplicates += ledger.applyDuplicateSnapshot(snapshot, await canonicalHash(snapshot.blockNumber)).duplicates;

    // Interrupted restart: checkpoint after the reorg, restore and continue; digests match.
    const checkpoint = ledger.checkpoint();
    const restored = CanonicalReconciliationLedger.fromCheckpoint(checkpoint);
    const projectionBefore = ledger.projection();
    const projectionRestored = restored.projection();
    const restartEqual = sha256(json(projectionBefore)) === sha256(json(projectionRestored));

    // Exact-block-hash balance observations at the final replacement tip.
    const finalNumber = await provider.getBlockNumber();
    const final = await initialState(finalNumber);
    const balanceResult = restored.reconcileBalanceObservations(final.balances);
    const conservation: Record<string, any> = {};
    for (const assetId of ["dEUR", "tWETH", "eFUND"]) {
      const observed = final.balances.filter((entry) => entry.assetId === assetId).reduce((sum, entry) => sum + BigInt(entry.amountBase), 0n);
      const supply = BigInt(final.supplies.find((entry) => entry.assetId === assetId)!.amountBase);
      conservation[assetId] = { observedAccountsTotal: observed.toString(), totalSupply: supply.toString(), conserved: observed === supply };
    }
    const releaseCounts = checkpoint.releasedReservations;
    const passed =
      reorg.orphanedEvents.length >= 3 &&
      reorg.replayedEvents.length >= 3 &&
      anchorRejection.includes("NONCANONICAL_ANCHOR") &&
      orphanBalanceRejected &&
      duplicates >= 3 &&
      restartEqual &&
      balanceResult.differences.length === 0 &&
      Object.values(conservation).every((entry: any) => entry.conserved === true) &&
      Object.keys(releaseCounts).length >= 1 &&
      reorg.auditTrail.some((entry) => entry.action === "orphan") &&
      reorg.auditTrail.some((entry) => entry.action === "replay");

    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    Object.assign(evidence, {
      commit,
      chain: { mode: "controlled-anvil", chainId: CHAIN_ID, rpc: RPC, exactBlockHashMethod: "EIP-1898 eth_call blockHash parameter", reorgRpc: "anvil_reorg" },
      contracts: { settlement: settlementAddress, escrow: escrowAddress, dEUR: cashAddress, tWETH: spotAddress, eFUND: fundAddress },
      initialCheckpoint,
      branches: {
        commonAncestor: { blockNumber: base.block.number, blockHash: base.block.hash },
        previous: { blocks: branchA, orphanedBlockHashes: orphanHashes },
        replacement: { blocks: replacementBranch, activityBlocks: branchB },
      },
      reorg: {
        depth: 2,
        orphanedEvents: reorg.orphanedEvents,
        replayedEvents: reorg.replayedEvents,
        duplicatesSkipped: duplicates,
        releasedReservations: reorg.releasedReservations,
        commonAncestorBlockHash: reorg.commonAncestorBlockHash,
      },
      anchors: {
        accepted: { blockHash: final.block.hash, blockNumber: final.block.number, observedBalances: final.balances.length },
        rejected: { orphanBlockHash: orphanHashes[0], canonicalReason: anchorRejection, exactHashBalanceError: orphanBalanceError, exactHashBalanceRejected: orphanBalanceRejected },
      },
      projection: { previousProjection, finalProjection: projectionBefore },
      duplicate: { duplicatesSkipped: duplicates, idempotent: duplicates >= 3 },
      restart: { checkpointSha256: sha256(json(checkpoint)), projectionSha256: sha256(json(projectionBefore)), restoredProjectionSha256: sha256(json(projectionRestored)), equal: restartEqual },
      reconciliation: { balanceResult, conservation },
      auditTrail: reorg.auditTrail,
      passed,
      limitations: [
        "The drill runs on a controlled anvil execution chain with automined blocks; it exercises the reconciliation and reorg-recovery logic, not a production consensus reorg.",
        "Exact-block-hash reads use EIP-1898; chains without that RPC extension need a block-number read plus a canonical hash check.",
        "The ledger tracks the settlement contracts used by this drill; the business API projection is reconciled by the same rules but not replayed here.",
      ],
      notes: [
        "Reservations are released exactly once; a second release event for the same order is counted as a duplicate and does not move money.",
        "The audit trail keeps both branches: the orphaned previous events and the replayed replacement events.",
        "Duplicate delivery and an interrupted restart both leave the projection unchanged.",
      ],
    });
    writeFileSync(join(evidenceDir, "reconciliation-reorg.json"), `${json(evidence)}\n`);
    console.log(`wrote evidence/s20/reconciliation-reorg.json passed=${String(passed)} orphaned=${String(reorg.orphanedEvents.length)} replayed=${String(reorg.replayedEvents.length)} duplicates=${String(duplicates)}`);
    if (!passed) process.exitCode = 1;
  } finally {
    anvil?.kill();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
