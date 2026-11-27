/**
 * A07 economics: measure one real sponsored ERC-4337 bundle and reconcile it in wei.
 *
 * Starts a local Anvil chain (pinned EntryPoint v0.7.0 artifacts), deploys the
 * SimpleAccount factory and the VerifyingPaymaster sample, then submits one
 * `handleOps` transaction containing two sponsored UserOperations: a successful
 * call and an included failure. The outer receipt, both UserOperationEvents and the
 * native balance movements are measured.
 *
 * The resulting evidence is written to:
 *   evidence/a07/bundle-reconciliation.json  (measured bundle in wei)
 *   benchmarks/cost-experiment.json          (observed defaults + scenario sweep)
 *
 * The plain Anvil chain does not expose an OP-stack L1 data fee or operator fee, so
 * those components are recorded as unavailable rather than guessed. The EUR/ETH
 * conversion is a timestamped demo fixture, stamped at the measurement block time.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  concat,
  getAddress,
  getBytes,
  parseEther,
  toBeHex,
  type TransactionReceipt,
} from "ethers";
import {
  evaluateCostExperiment,
  reconcileBundle,
  runScenarioMatrix,
  type BundleMeasurement,
  type CostExperimentInputs,
  type RateObservation,
} from "../packages/economics/src/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = join(repoRoot, "node_modules/@account-abstraction/contracts/artifacts");
const anvilBin = process.env.ANVIL_BIN ?? join(process.env.HOME ?? "", ".foundry", "bin", "anvil");
const RPC_URL = process.env.A07_RPC_URL ?? "http://127.0.0.1:8549";
const CHAIN_ID = 31337;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

function artifact(name: string): { abi: string; bytecode: string } {
  return JSON.parse(readFileSync(join(artifactsRoot, `${name}.json`), "utf8")) as { abi: string; bytecode: string };
}

function walletAt(index: number): HDNodeWallet {
  return HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

async function waitForRpc(provider: JsonRpcProvider): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Anvil did not start in time");
}

interface MeasuredOp {
  opId: string;
  success: boolean;
  actualGasCostWei: bigint;
  actualGasUsed: bigint;
  userOpHash: string;
  accountAddress: string;
}

async function main(): Promise<void> {
  let anvil: ChildProcess | undefined;
  try {
    anvil = spawn(anvilBin, ["--port", "8549", "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
    const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
    await waitForRpc(provider);

    const deployer = walletAt(0).connect(provider);
    const bundler = walletAt(1).connect(provider);
    const ownerOne = walletAt(2).connect(provider);
    const beneficiary = walletAt(3).connect(provider);
    const sponsorSigner = walletAt(4).connect(provider);

    const entryPointArtifact = artifact("EntryPoint");
    const factoryArtifact = artifact("SimpleAccountFactory");
    const paymasterArtifact = artifact("VerifyingPaymaster");
    const accountArtifact = artifact("SimpleAccount");

    const entryPoint = await new ContractFactory(entryPointArtifact.abi, entryPointArtifact.bytecode, deployer).deploy();
    await entryPoint.waitForDeployment();
    const entryPointAddress = getAddress(await entryPoint.getAddress());

    const factory = await new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, deployer).deploy(entryPointAddress);
    await factory.waitForDeployment();
    const factoryAddress = getAddress(await factory.getAddress());

    const paymaster = await new ContractFactory(paymasterArtifact.abi, paymasterArtifact.bytecode, deployer).deploy(
      entryPointAddress,
      sponsorSigner.address,
    );
    await paymaster.waitForDeployment();
    const paymasterAddress = getAddress(await paymaster.getAddress());

    const accountOwnerTwo = walletAt(5).connect(provider);
    const factoryContract = new Contract(factoryAddress, factoryArtifact.abi, deployer);
    await (await factoryContract.getFunction("createAccount")(ownerOne.address, 1n)).wait();
    await (await factoryContract.getFunction("createAccount")(accountOwnerTwo.address, 2n)).wait();
    const accountOne = getAddress((await factoryContract.getFunction("getAddress")(ownerOne.address, 1n)) as string);
    const accountTwo = getAddress((await factoryContract.getFunction("getAddress")(accountOwnerTwo.address, 2n)) as string);

    const sponsorDeposit = parseEther("1");
    const paymasterWithSigner = new Contract(paymasterAddress, paymasterArtifact.abi, deployer);
    await (await paymasterWithSigner.getFunction("deposit")({ value: sponsorDeposit })).wait();

    // A tiny contract whose runtime is "PUSH1 0 PUSH1 0 REVERT"; used for the
    // included-failure operation without needing a Solidity compiler here.
    const failingDeploy = await deployer.sendTransaction({ data: "0x600580600b6000396000f360006000fd" });
    const failingReceipt = (await failingDeploy.wait()) as TransactionReceipt;
    const failingTarget = failingReceipt.contractAddress;
    if (failingTarget === null || failingTarget === undefined) throw new Error("failed to deploy the reverting target");

    const entryPointContract = new Contract(entryPointAddress, entryPointArtifact.abi, provider);
    const paymasterContract = new Contract(paymasterAddress, paymasterArtifact.abi, provider);
    const accountContract = new Contract(accountOne, accountArtifact.abi, provider);
    const abiCoder = AbiCoder.defaultAbiCoder();
    const block = await provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
    const validUntil = now + 3600n;
    const validAfter = 0n;

    const GAS = {
      verificationGasLimit: 400_000n,
      callGasLimit: 200_000n,
      paymasterVerificationGasLimit: 200_000n,
      paymasterPostOpGasLimit: 80_000n,
      preVerificationGas: 80_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 3_000_000_000n,
    };

    async function buildUserOp(account: string, owner: HDNodeWallet, target: string): Promise<{ userOp: Record<string, unknown>; userOpHash: string }> {
      const accountInstance = new Contract(account, accountArtifact.abi, provider);
      const nonce = (await entryPointContract.getNonce(account, 0)) as bigint;
      const accountGasLimits = concat([toBeHex(GAS.verificationGasLimit, 16), toBeHex(GAS.callGasLimit, 16)]);
      const gasFees = concat([toBeHex(GAS.maxPriorityFeePerGas, 16), toBeHex(GAS.maxFeePerGas, 16)]);
      const callData = accountInstance.interface.encodeFunctionData("execute", [target, 0n, "0x"]);
      const timestampData = abiCoder.encode(["uint48", "uint48"], [validUntil, validAfter]);
      const paymasterHeader = concat([
        paymasterAddress,
        toBeHex(GAS.paymasterVerificationGasLimit, 16),
        toBeHex(GAS.paymasterPostOpGasLimit, 16),
        timestampData,
      ]);
      const baseUserOp = {
        sender: account,
        nonce,
        initCode: "0x",
        callData,
        accountGasLimits,
        preVerificationGas: GAS.preVerificationGas,
        gasFees,
        paymasterAndData: concat([paymasterHeader, new Uint8Array(65)]),
        signature: "0x",
      };
      const paymasterHash = (await paymasterContract.getFunction("getHash")(baseUserOp, validUntil, validAfter)) as string;
      const sponsorSignature = await sponsorSigner.signMessage(getBytes(paymasterHash));
      const paymasterAndData = concat([paymasterHeader, sponsorSignature]);
      const userOpWithoutSig = { ...baseUserOp, paymasterAndData };
      const userOpHash = (await entryPointContract.getFunction("getUserOpHash")(userOpWithoutSig)) as string;
      const accountSignature = await owner.signMessage(getBytes(userOpHash));
      return { userOp: { ...userOpWithoutSig, signature: accountSignature }, userOpHash };
    }

    const successTarget = "0x000000000000000000000000000000000000dEaD";
    const opOne = await buildUserOp(accountOne, ownerOne, successTarget);
    const opTwo = await buildUserOp(accountTwo, accountOwnerTwo, failingTarget);

    const handleOpsData = entryPointContract.interface.encodeFunctionData("handleOps", [
      [opOne.userOp, opTwo.userOp],
      beneficiary.address,
    ]);
    // Preflight the exact bundle so the evidence never records an unattributable revert.
    await provider.call({ to: entryPointAddress, data: handleOpsData, from: bundler.address });

    const blockBefore = await provider.getBlockNumber();
    const balanceAt = async (address: string, blockTag: number): Promise<bigint> =>
      BigInt((await provider.send("eth_getBalance", [address, `0x${blockTag.toString(16)}`])) as string);
    const depositAt = async (blockTag: number): Promise<bigint> =>
      (await entryPointContract.balanceOf(paymasterAddress, { blockTag })) as bigint;

    const depositBefore = await depositAt(blockBefore);
    const beneficiaryBefore = await balanceAt(beneficiary.address, blockBefore);
    const entryPointBalanceBefore = await balanceAt(entryPointAddress, blockBefore);
    const tx = await bundler.sendTransaction({ to: entryPointAddress, data: handleOpsData, gasLimit: 5_000_000n });
    const receipt = (await tx.wait()) as TransactionReceipt;
    const bundleBlock = await provider.getBlock(receipt.blockNumber);
    // Read the after-state at the receipt block so a lagging "latest" tag cannot
    // make the measured deltas non-deterministic.
    const beneficiaryAfter = await balanceAt(beneficiary.address, receipt.blockNumber);
    const entryPointBalanceAfter = await balanceAt(entryPointAddress, receipt.blockNumber);
    const depositAfter = await depositAt(receipt.blockNumber);

    if (entryPointBalanceBefore !== null) void entryPointBalanceAfter;
    const ops = new Map<string, MeasuredOp>();
    for (const log of receipt.logs) {
      let parsed;
      try {
        parsed = entryPointContract.interface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        continue;
      }
      if (parsed === null || parsed.name !== "UserOperationEvent") continue;
      const userOpHash = parsed.args["userOpHash"] as string;
      const known = userOpHash.toLowerCase() === opOne.userOpHash.toLowerCase()
        ? { opId: "opus-success", accountAddress: accountOne, expectedSuccess: true }
        : userOpHash.toLowerCase() === opTwo.userOpHash.toLowerCase()
          ? { opId: "opus-included-failure", accountAddress: accountTwo, expectedSuccess: false }
          : null;
      if (known === null) throw new Error(`unexpected UserOperationEvent ${userOpHash}`);
      ops.set(known.opId, {
        opId: known.opId,
        success: parsed.args["success"] as boolean,
        actualGasCostWei: parsed.args["actualGasCost"] as bigint,
        actualGasUsed: parsed.args["actualGasUsed"] as bigint,
        userOpHash,
        accountAddress: known.accountAddress,
      });
    }
    if (ops.size !== 2) throw new Error(`expected two UserOperationEvents, got ${ops.size.toString()}`);

    const rateFixture = JSON.parse(readFileSync(join(repoRoot, "fixtures/economics/rate.json"), "utf8")) as {
      pair: "EUR/ETH";
      rateEurPerEth: string;
      rateMicrosPerEth: string;
      maxAgeSeconds: number;
    };
    const observedAt = new Date(Number(bundleBlock?.timestamp ?? now) * 1000).toISOString();
    const rate: RateObservation = {
      pair: rateFixture.pair,
      rateEurPerEth: rateFixture.rateEurPerEth,
      rateMicrosPerEth: BigInt(rateFixture.rateMicrosPerEth),
      observedAt,
      source: "demo-fixture",
      maxAgeSeconds: rateFixture.maxAgeSeconds,
    };

    const measurement: BundleMeasurement = {
      outerGasUsed: receipt.gasUsed,
      effectiveGasPriceWei: receipt.gasPrice ?? 0n,
      l1DataFeeWei: null,
      operatorFeeWei: null,
      paymasterDepositDeltaWei: depositAfter - depositBefore,
      beneficiaryDeltaWei: beneficiaryAfter - beneficiaryBefore,
      ops: [...ops.values()].map((op) => ({
        opId: op.opId,
        actualGasUsed: op.actualGasUsed,
        actualGasCostWei: op.actualGasCostWei,
        success: op.success,
        userChargeWei: 0n,
      })),
      investorChargeEurMicros: 50_000n,
      rate,
      rateObservedNowEpochSeconds: Number(bundleBlock?.timestamp ?? now),
      dataMode: "measured",
    };
    const reconciliation = reconcileBundle(measurement);

    const costFixture = JSON.parse(readFileSync(join(repoRoot, "fixtures/economics/cost-inputs.json"), "utf8")) as {
      dailyOrders: number;
      eligibleSponsorShareBps: number;
      daPriceWeiPerByte: number;
      batchUtilizationBps: number;
      perOrderExecutionGas: number;
      l1DataBytesPerOrder: number;
      gasPriceWei: number;
      investorChargeEurMicros: number;
      dailyBudgetEurMicros: number;
      notes: string[];
    };
    const measuredGasPrice = receipt.gasPrice ?? BigInt(costFixture.gasPriceWei);
    const measuredPerOrderGas = [...ops.values()].reduce((sum, op) => (op.actualGasUsed > sum ? op.actualGasUsed : sum), 0n);
    const perOrderGas = measuredPerOrderGas;
    const baseInputs: CostExperimentInputs = {
      dailyOrders: costFixture.dailyOrders,
      eligibleSponsorShareBps: costFixture.eligibleSponsorShareBps,
      rate,
      rateAgeSeconds: 0,
      daPriceWeiPerByte: BigInt(costFixture.daPriceWeiPerByte),
      batchUtilizationBps: costFixture.batchUtilizationBps,
      perOrderExecutionGas: perOrderGas,
      l1DataBytesPerOrder: BigInt(costFixture.l1DataBytesPerOrder),
      gasPriceWei: measuredGasPrice,
      investorChargeEurMicros: BigInt(costFixture.investorChargeEurMicros),
      dailyBudgetEurMicros: BigInt(costFixture.dailyBudgetEurMicros),
    };
    const scenarios = runScenarioMatrix(baseInputs, [
      { scenarioId: "observed-default", description: "Recorded defaults with the demo DA price and utilization.", patch: {} },
      { scenarioId: "cheap-da", description: "Half the demo DA price.", patch: { daPriceWeiPerByte: BigInt(costFixture.daPriceWeiPerByte) / 2n } },
      { scenarioId: "low-utilization", description: "Batch utilization drops to 30%.", patch: { batchUtilizationBps: 3_000 } },
      { scenarioId: "lower-investor-fee", description: "Investor charge halves to 0.025 EUR.", patch: { investorChargeEurMicros: 25_000n } },
      { scenarioId: "higher-volume", description: "Daily order count doubles.", patch: { dailyOrders: costFixture.dailyOrders * 2 } },
    ]);

    const bundleEvidence = {
      schemaVersion: "1.0.0",
      reportId: "A07-bundle-reconciliation",
      packId: "A07-economics",
      generatedBy: "pnpm a07:economics",
      generatedAt: new Date().toISOString(),
      chain: { chainId: CHAIN_ID, rpc: RPC_URL, runtime: "anvil (local, ephemeral)" },
      contracts: {
        entryPoint: entryPointAddress,
        entryPointArtifact: "@account-abstraction/contracts@0.7.0 EntryPoint",
        accountFactory: factoryAddress,
        paymaster: paymasterAddress,
        paymasterArtifact: "@account-abstraction/contracts@0.7.0 VerifyingPaymaster",
        beneficiary: beneficiary.address,
      },
      bundle: {
        outerTxHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        blockTimestamp: observedAt,
        outerStatus: receipt.status,
        outerGasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: (receipt.gasPrice ?? 0n).toString(),
        executionFeeWei: reconciliation.executionFeeWei.toString(),
        l1DataFeeWei: reconciliation.l1DataFeeWei?.toString() ?? null,
        operatorFeeWei: reconciliation.operatorFeeWei?.toString() ?? null,
        networkCostWei: reconciliation.networkCostWei.toString(),
        sponsorPaidWei: reconciliation.sponsorPaidWei.toString(),
        bundlerRevenueWei: reconciliation.bundlerRevenueWei.toString(),
        bundleTotalWei: reconciliation.bundleTotalWei.toString(),
        operations: [...ops.values()].map((op) => ({
          opId: op.opId,
          accountAddress: op.accountAddress,
          userOpHash: op.userOpHash,
          success: op.success,
          actualGasUsed: op.actualGasUsed.toString(),
          actualGasCostWei: op.actualGasCostWei.toString(),
          userChargeWei: "0",
        })),
      },
      reconciliation: {
        items: reconciliation.reconciliationItems,
        allocations: reconciliation.allocations.map((allocation) => ({
          bucket: allocation.bucket,
          opId: allocation.opId,
          gasUsed: allocation.gasUsed.toString(),
          allocWei: allocation.allocWei.toString(),
        })),
        successfulAllocWei: reconciliation.successfulAllocWei.toString(),
        failedAllocWei: reconciliation.failedAllocWei.toString(),
        residualWei: reconciliation.residualWei.toString(),
        invariants: reconciliation.invariants,
      },
      charges: {
        investorChargeEurMicros: reconciliation.investorChargeEurMicros.toString(),
        investorChargeSource: "0.05 dEUR spot charge fixture (same charge as the G01 spot fill)",
        sponsorCostEurMicros: reconciliation.sponsorCostEurMicros?.toString() ?? null,
        sponsorContributionEurMicros: reconciliation.sponsorContributionEurMicros?.toString() ?? null,
        rateObservation: rate,
        rateFreshness: reconciliation.rateFreshness,
      },
      unavailable: reconciliation.unavailable,
      dataMode: "measured-bundle-with-demo-rate",
      notes: [
        "The bundle is a real two-operation handleOps transaction on a local Anvil chain.",
        "L1 data fee and operator fee are unavailable on this chain and are recorded as null, not as zero.",
        "The EUR/ETH conversion is a timestamped demo fixture stamped at the measurement block time; it is not a live market rate.",
      ],
    };

    const experimentEvidence = {
      schemaVersion: "1.0.0",
      reportId: "A07-cost-experiment",
      packId: "A07-economics",
      generatedBy: "pnpm a07:economics",
      generatedAt: new Date().toISOString(),
      observedRun: {
        bundleOuterTxHash: receipt.hash,
        perOrderActualGas: [...ops.values()].map((op) => ({ opId: op.opId, actualGasUsed: op.actualGasUsed.toString(), actualGasCostWei: op.actualGasCostWei.toString() })),
        outerGasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: (receipt.gasPrice ?? 0n).toString(),
        sponsorPaidWei: reconciliation.sponsorPaidWei.toString(),
        bundleTotalWei: reconciliation.bundleTotalWei.toString(),
      },
      scenarioInputs: costFixture,
      observedDefaults: {
        perOrderExecutionGas: perOrderGas.toString(),
        gasPriceWei: measuredGasPrice.toString(),
        source: "measured from the recorded bundle outer transaction and UserOperationEvents",
        syntheticInputs: ["dailyOrders", "eligibleSponsorShareBps", "daPriceWeiPerByte", "batchUtilizationBps", "l1DataBytesPerOrder", "investorChargeEurMicros", "dailyBudgetEurMicros"],
        dataMode: "mixed: execution cost measured, DA/order-volume inputs are explicit synthetic scenario inputs",
      },
      scenarios,
      unavailable: scenarios[0]?.result.unavailable ?? [],
      notes: [
        "The default scenario is the last observed run for execution cost; DA price and batch utilization are explicit synthetic inputs.",
        "A missing input is displayed as unavailable and never replaced by zero.",
      ],
    };

    mkdirSync(join(repoRoot, "evidence/a07"), { recursive: true });
    mkdirSync(join(repoRoot, "benchmarks"), { recursive: true });
    writeFileSync(join(repoRoot, "evidence/a07/bundle-reconciliation.json"), `${JSON.stringify(jsonSafe(bundleEvidence), null, 2)}\n`);
    writeFileSync(join(repoRoot, "benchmarks/cost-experiment.json"), `${JSON.stringify(jsonSafe(experimentEvidence), null, 2)}\n`);

    console.log(`bundle ${receipt.hash} outerGas=${receipt.gasUsed.toString()} sponsorPaid=${reconciliation.sponsorPaidWei.toString()} wei`);
    console.log(`allocation invariant: ${reconciliation.invariants.allocationsPlusResidualEqualsTotal}`);
    console.log(`sponsor contribution: ${reconciliation.sponsorContributionEurMicros?.toString() ?? "unavailable"} micro-EUR`);
    console.log(`first exhausting daily orders: ${scenarios[0]!.result.firstExhaustingDailyOrders?.toString() ?? "none"}`);
    console.log("wrote evidence/a07/bundle-reconciliation.json and benchmarks/cost-experiment.json");
  } finally {
    if (process.env.A07_KEEP_ANVIL !== "1") anvil?.kill();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
