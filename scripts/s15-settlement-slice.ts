/**
 * S15 / SET-01 contract-backed settlement vertical slice.
 *
 * Deploys dEUR, tWETH, the restricted eFUND share, a cash escrow and the atomic DvP
 * settlement contract on the controlled local OP Stack L2 (chain id 16584), then runs
 * the G01 lifecycle from the seed through allocation plus the independent redemption
 * case. Expected amounts come from the frozen G01 fixture/dealing arithmetic; observed
 * balances are read from chain at one canonical block. Writes evidence/s15/*.json.
 *
 * Requires: `pnpm devnet:local:up` (or `pnpm devnet:up`) and `pnpm contracts:build`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, MaxUint256, keccak256, toUtf8Bytes } from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s15");
const abiDir = join(repoRoot, "contracts", "abi");
const runDir = process.env.DEVNET_LOCAL_RUN_DIR ?? join(repoRoot, ".devnet-local", "run");
const envPath = join(runDir, "env.json");
const chainId = 16584;

/** Loose contract handle: ABI calls are validated on-chain and by the Foundry tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContract = Record<string, any>;

const CASH_UNIT = 1_000_000n; // dEUR 6 decimals
const FUND_UNIT = 1_000_000n; // eFUND 6 decimals
const SPOT_UNIT = 1_000_000_000_000_000_000n; // tWETH 18 decimals

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function artifactPath(name: string): string {
  return join(repoRoot, "contracts", "out", `${name}.sol`, `${name}.json`);
}
function readArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const artifact = JSON.parse(readFileSync(artifactPath(name), "utf8")) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: artifact.abi, bytecode: artifact.bytecode.object };
}
function deterministicWallet(label: string, provider: JsonRpcProvider): Wallet {
  // Deterministic synthetic local accounts: the same evidence flow produces the same
  // addresses on every run. These are lab keys on a controlled devnet, never secrets.
  const key = keccak256(toUtf8Bytes(`eurorollup-s15-${label}`));
  return new Wallet(key, provider);
}
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function waitForDevnet(): Promise<{ l1Rpc: string; l2Rpc: string; portal: string; deployerKey: string; deployerAddress: string }> {
  const started = Date.now();
  for (;;) {
    if (existsSync(envPath)) {
      try {
        const env = JSON.parse(readFileSync(envPath, "utf8")) as {
          l1Rpc: string;
          l2Rpc: string;
          portal: string;
          keys: { deployer: string };
          addresses: { deployer: string };
        };
        const provider = new JsonRpcProvider(env.l2Rpc, undefined, { staticNetwork: true });
        const network = await provider.getNetwork();
        if (Number(network.chainId) === chainId) {
          return { l1Rpc: env.l1Rpc, l2Rpc: env.l2Rpc, portal: env.portal, deployerKey: env.keys.deployer, deployerAddress: env.addresses.deployer };
        }
      } catch {
        // devnet still starting
      }
    }
    if (Date.now() - started > 600_000) throw new Error("timed out waiting for the controlled devnet L2");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

interface Deployment {
  name: string;
  contract: string;
  address: string;
  txHash: string;
  blockNumber: number;
  codeHash: string;
  abiSha256: string;
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(abiDir, { recursive: true });
  const { l1Rpc, l2Rpc, portal, deployerKey, deployerAddress } = await waitForDevnet();
  const provider = new JsonRpcProvider(l2Rpc, undefined, { staticNetwork: true });
  const operator = new Wallet(deployerKey, provider);

  // The controlled L2 starts with unfunded accounts: bridge gas ETH from the L1
  // deployer through the canonical OptimismPortal when the L2 balance is too low.
  let l2FundingTx: string | null = null;
  const startBalance = await provider.getBalance(operator.address);
  if (startBalance < 10n ** 18n) {
    const l1Provider = new JsonRpcProvider(l1Rpc, undefined, { staticNetwork: true });
    const l1Wallet = new Wallet(deployerKey, l1Provider);
    const portalContract = new Contract(portal, [
      "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
    ], l1Wallet);
    const deposit = await portalContract.depositTransaction(operator.address, 5n * 10n ** 18n, 200_000n, false, "0x", { value: 5n * 10n ** 18n });
    const receipt = await deposit.wait();
    l2FundingTx = receipt!.hash;
    const started = Date.now();
    for (;;) {
      if ((await provider.getBalance(operator.address)) >= 10n ** 18n) break;
      if (Date.now() - started > 600_000) throw new Error("timed out waiting for the bridged L2 gas ETH");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  const investor = deterministicWallet("investor", provider);
  const dealer = deterministicWallet("dealer", provider);
  const feeRecipient = deterministicWallet("fee-recipient", provider);
  const issuerTreasury = deterministicWallet("issuer-treasury", provider);
  const actors = { investor, dealer, feeRecipient, issuerTreasury };

  // Fund the synthetic actor accounts with L2 ETH for gas from the devnet deployer.
  const fundingTxs: Array<{ label: string; address: string; txHash: string }> = [];
  for (const [label, wallet] of Object.entries(actors)) {
    const balance = await provider.getBalance(wallet.address);
    if (balance < 10n ** 17n) {
      const tx = await operator.sendTransaction({ to: wallet.address, value: 5n * 10n ** 17n });
      await tx.wait();
      fundingTxs.push({ label, address: wallet.address, txHash: tx.hash });
    }
  }

  const artifacts = {
    Token: readArtifact("Token"),
    RestrictedShare: readArtifact("RestrictedShare"),
    Escrow: readArtifact("Escrow"),
    DvPSettlement: readArtifact("DvPSettlement"),
  };
  for (const [name, artifact] of Object.entries(artifacts)) {
    writeFileSync(join(abiDir, `${name}.json`), `${json(artifact.abi)}\n`);
  }

  const deployments: Deployment[] = [];
  const deploy = async (
    name: string,
    contractName: keyof typeof artifacts,
    args: readonly unknown[],
    label: string,
  ): Promise<AnyContract> => {
    const factory = new ContractFactory(artifacts[contractName].abi, artifacts[contractName].bytecode, operator);
    const contract = (await factory.deploy(...args)) as unknown as AnyContract;
    const receipt = await contract.deploymentTransaction()!.wait();
    const address = await contract.getAddress();
    const code = await provider.getCode(address);
    deployments.push({
      name: label,
      contract: contractName,
      address,
      txHash: receipt!.hash,
      blockNumber: receipt!.blockNumber,
      codeHash: keccak256(code),
      abiSha256: sha256File(join(abiDir, `${contractName}.json`)),
    });
    return contract;
  };

  const cash = await deploy("dEUR", "Token", ["Demo euro cash", "dEUR", 6], "cash");
  const spot = await deploy("tWETH", "Token", ["Test wrapped ETH", "tWETH", 18], "spot");
  const fund = await deploy("eFUND", "RestrictedShare", ["Fictional euro fund unit", "eFUND", 6, operator.address], "fund");
  const escrow = await deploy("Cash escrow", "Escrow", [await cash.getAddress()], "escrow");
  const settlement = await deploy(
    "DvP settlement",
    "DvPSettlement",
    [await cash.getAddress(), await spot.getAddress(), await fund.getAddress(), await escrow.getAddress(), feeRecipient.address, issuerTreasury.address],
    "settlement",
  );
  const settlementAddress = await settlement.getAddress();

  const transactions: Array<{ stage: string; label: string; txHash: string; blockNumber: number; gasUsed: string; status: number }> = [];
  const send = async (stage: string, label: string, promise: Promise<{ wait: () => Promise<{ hash: string; blockNumber: number; gasUsed: bigint; status: number } | null> }>): Promise<void> => {
    const tx = await promise;
    const receipt = await tx.wait();
    if (receipt === null) throw new Error(`${stage}: transaction was dropped`);
    transactions.push({ stage, label, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status ?? 0 });
  };

  // Role wiring: escrow operator is the settlement contract; the fund issuer authorises
  // settlement as a minter and allowlists the three synthetic participants.
  await send("wiring", "escrow.setOperator(settlement)", escrow.setOperator(settlementAddress) as never);
  await send("wiring", "fund.setMinter(settlement)", fund.setMinter(settlementAddress, true) as never);
  for (const [label, wallet] of Object.entries(actors)) {
    await send("eligibility", `fund.setEligible(${label})`, fund.setEligible(wallet.address, true) as never);
  }

  // Initial synthetic balances from the G01 fixture seed and dealer inventory.
  await send("seed", "cash.mint(investor, 1000 dEUR)", cash.mint(investor.address, 1_000n * CASH_UNIT) as never);
  await send("seed", "cash.mint(issuerTreasury, 500 dEUR)", cash.mint(issuerTreasury.address, 500n * CASH_UNIT) as never);
  await send("seed", "spot.mint(dealer, 1 tWETH)", spot.mint(dealer.address, 1n * SPOT_UNIT) as never);
  await send("approvals", "investor approves settlement cash", cash.connect(investor).approve(settlementAddress, MaxUint256) as never);
  await send("approvals", "investor approves escrow cash", cash.connect(investor).approve(await escrow.getAddress(), MaxUint256) as never);
  await send("approvals", "dealer approves settlement tWETH", spot.connect(dealer).approve(settlementAddress, MaxUint256) as never);
  await send("approvals", "issuerTreasury approves settlement cash", cash.connect(issuerTreasury).approve(settlementAddress, MaxUint256) as never);

  const latest = await provider.getBlock("latest");
  const deadline = BigInt(latest!.timestamp + 3_600);
  const stages: Array<Record<string, unknown>> = [];

  const snapshot = async (stage: string, blockTag: number): Promise<Record<string, string>> => {
    const cashAt = async (wallet: Wallet): Promise<string> =>
      (await cash.balanceOf(wallet.address, { blockTag })).toString();
    return {
      investorCash: await cashAt(investor),
      investorSpot: (await spot.balanceOf(investor.address, { blockTag })).toString(),
      investorFund: (await fund.balanceOf(investor.address, { blockTag })).toString(),
      dealerCash: await cashAt(dealer),
      dealerSpot: (await spot.balanceOf(dealer.address, { blockTag })).toString(),
      feeRecipientCash: await cashAt(feeRecipient),
      issuerTreasuryCash: await cashAt(issuerTreasury),
      escrowCash: (await cash.balanceOf(await escrow.getAddress(), { blockTag })).toString(),
      fundTotalSupply: (await fund.totalSupply({ blockTag })).toString(),
    };
  };

  const stageExpected: Record<string, Record<string, string>> = {
    seed: {
      investorCash: (1_000n * CASH_UNIT).toString(),
      investorSpot: "0",
      investorFund: "0",
      dealerCash: "0",
      dealerSpot: (1n * SPOT_UNIT).toString(),
      feeRecipientCash: "0",
      issuerTreasuryCash: (500n * CASH_UNIT).toString(),
      escrowCash: "0",
      fundTotalSupply: "0",
    },
    spot: {
      investorCash: "799950000",
      investorSpot: (SPOT_UNIT / 10n).toString(),
      investorFund: "0",
      dealerCash: (200n * CASH_UNIT).toString(),
      dealerSpot: (9n * SPOT_UNIT / 10n).toString(),
      feeRecipientCash: "50000",
      issuerTreasuryCash: (500n * CASH_UNIT).toString(),
      escrowCash: "0",
      fundTotalSupply: "0",
    },
    reserved: {
      investorCash: "499950000",
      investorSpot: (SPOT_UNIT / 10n).toString(),
      investorFund: "0",
      dealerCash: (200n * CASH_UNIT).toString(),
      dealerSpot: (9n * SPOT_UNIT / 10n).toString(),
      feeRecipientCash: "50000",
      issuerTreasuryCash: (500n * CASH_UNIT).toString(),
      escrowCash: (300n * CASH_UNIT).toString(),
      fundTotalSupply: "0",
    },
    allocated: {
      investorCash: "499950000",
      investorSpot: (SPOT_UNIT / 10n).toString(),
      investorFund: "3125000",
      dealerCash: (200n * CASH_UNIT).toString(),
      dealerSpot: (9n * SPOT_UNIT / 10n).toString(),
      feeRecipientCash: "50000",
      issuerTreasuryCash: (800n * CASH_UNIT).toString(),
      escrowCash: "0",
      fundTotalSupply: "3125000",
    },
    redeemed: {
      investorCash: "597950000",
      investorSpot: (SPOT_UNIT / 10n).toString(),
      investorFund: "2125000",
      dealerCash: (200n * CASH_UNIT).toString(),
      dealerSpot: (9n * SPOT_UNIT / 10n).toString(),
      feeRecipientCash: "50000",
      issuerTreasuryCash: (702n * CASH_UNIT).toString(),
      escrowCash: "0",
      fundTotalSupply: "2125000",
    },
  };

  const checkStage = async (stage: string, blockNumber: number): Promise<void> => {
    const observed = await snapshot(stage, blockNumber);
    const expected = stageExpected[stage]!;
    const mismatches = Object.keys(expected).filter((key) => observed[key] !== expected[key]);
    stages.push({
      stage,
      blockNumber,
      orderId: null,
      expected,
      observed,
      mismatches,
      passed: mismatches.length === 0,
    });
    if (mismatches.length > 0) throw new Error(`stage ${stage} mismatch: ${mismatches.join(", ")}`);
  };

  const latestBlock = await provider.getBlockNumber();
  await checkStage("seed", latestBlock);

  await send("spot", "settlement.executeSpot(G01-SPOT-01)", settlement.executeSpot(
    keccak256(toUtf8Bytes("G01-SPOT-01")),
    investor.address,
    dealer.address,
    200n * CASH_UNIT,
    50_000n,
    100_000_000_000_000_000n,
    deadline,
  ) as never);
  await checkStage("spot", transactions[transactions.length - 1]!.blockNumber);

  await send("reserved", "settlement.reserveFund(G01-FUND-01)", settlement.reserveFund(keccak256(toUtf8Bytes("G01-FUND-01")), investor.address, 300n * CASH_UNIT) as never);
  await checkStage("reserved", transactions[transactions.length - 1]!.blockNumber);

  await send("allocated", "settlement.allocateFund(G01-FUND-01)", settlement.allocateFund(keccak256(toUtf8Bytes("G01-FUND-01")), investor.address, 3_125_000n, 300n * CASH_UNIT) as never);
  await checkStage("allocated", transactions[transactions.length - 1]!.blockNumber);

  await send("redeemed", "settlement.redeemFund(G01-RED-01)", settlement.redeemFund(keccak256(toUtf8Bytes("G01-RED-01")), investor.address, 1_000_000n, 98n * CASH_UNIT) as never);
  await checkStage("redeemed", transactions[transactions.length - 1]!.blockNumber);

  const canonicalBlock = await provider.getBlockNumber();
  const canonical = await provider.getBlock(canonicalBlock);
  const balancesAtCanonicalBlock = await snapshot("canonical", canonicalBlock);

  const abiFiles = Object.entries(artifacts).map(([name, artifact]) => ({
    name,
    path: `contracts/abi/${name}.json`,
    sha256: sha256File(join(abiDir, `${name}.json`)),
    abiLength: artifact.abi.length,
  }));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "S15-settlement-slice",
    packId: "S15",
    generatedBy: "pnpm s15:run",
    generatedAt: new Date().toISOString(),
    commit,
    chains: {
      l1ChainId: 11155111,
      l2ChainId: chainId,
      lane: "controlled local OP Stack devnet (calldata DA development mode)",
      l2Rpc,
    },
    accounts: {
      synthetic: true,
      note: "Deterministic lab accounts derived from labelled strings on the controlled devnet; not production keys.",
      operator: operator.address,
      deployer: deployerAddress,
      investor: investor.address,
      dealer: dealer.address,
      feeRecipient: feeRecipient.address,
      issuerTreasury: issuerTreasury.address,
    },
    assets: {
      cash: { symbol: "dEUR", decimals: 6, address: deployments.find((entry) => entry.name === "cash")!.address },
      spot: { symbol: "tWETH", decimals: 18, address: deployments.find((entry) => entry.name === "spot")!.address },
      fund: { symbol: "eFUND", decimals: 6, address: deployments.find((entry) => entry.name === "fund")!.address, restricted: true },
    },
    deployments,
    abis: abiFiles,
    fundingTransactions: { l1ToL2DepositTx: l2FundingTx, actorFunding: fundingTxs },
    transactions,
    stages,
    canonicalBlock: { number: canonicalBlock, hash: canonical!.hash, timestamp: canonical!.timestamp },
    balancesAtCanonicalBlock,
    limits: {
      businessDigest: null,
      note: "Observed balances match the frozen G01 arithmetic; the dealing-engine business digest is checked by the G01 evidence pack.",
    },
    passed: stages.every((stage) => stage["passed"] === true) && transactions.every((entry) => entry.status === 1),
    limitations: [
      "The slice runs on the controlled local OP Stack L2 (calldata DA development mode); L1 consensus finality and blob DA are not part of this step.",
      "Eligibility is a simple issuer-controlled allowlist here; S16 adds the onchain Noir proof and expiry/rotation checks.",
      "The tokens, escrow and settlement contracts are synthetic lab contracts, not audited production code.",
    ],
    notes: [
      "Expected values are the frozen G01 fixture amounts in integer base units.",
      "Every stage is atomic: a failed leg reverts the whole transaction.",
      "Balances are read at one canonical L2 block so the witness is comparable across accounts.",
    ],
  };
  writeFileSync(join(evidenceDir, "settlement-slice.json"), `${json(evidence)}\n`);
  console.log(`wrote evidence/s15/settlement-slice.json passed=${String(evidence.passed)} stages=${String(stages.length)} txs=${String(transactions.length)}`);
  if (!evidence.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
