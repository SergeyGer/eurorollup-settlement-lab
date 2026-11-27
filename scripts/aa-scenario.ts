/**
 * A04 account-abstraction scenario.
 *
 * Starts a local Anvil chain, deploys the pinned ERC-4337 EntryPoint v0.7.0,
 * SimpleAccountFactory and the VerifyingPaymaster sample, then observes three
 * real sponsored UserOperations:
 *
 *   1. a sponsored success,
 *   2. an included failure (the inner call reverts but the sponsor still pays),
 *   3. an exhausted sponsor (paymaster deposit too low, hand
 *      validation rejects the bundle).
 *
 * The script records user charge, sponsor native-deposit movements, hash
 * presence and inclusion status as `evidence/a04/aa-receipts.json`.
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
  getBytes,
  parseEther,
  toBeHex,
  type TransactionReceipt,
} from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = join(repoRoot, "node_modules/@account-abstraction/contracts/artifacts");
const anvilBin = process.env.ANVIL_BIN ?? join(process.env.HOME ?? "", ".foundry", "bin", "anvil");
const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

function artifact(name: string): { abi: string; bytecode: string } {
  const parsed = JSON.parse(
    readFileSync(join(artifactsRoot, `${name}.json`), "utf8"),
  ) as { abi: string; bytecode: string };
  return parsed;
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

function walletAt(index: number): HDNodeWallet {
  return HDNodeWallet.fromPhrase(
    ANVIL_MNEMONIC,
    undefined,
    `m/44'/60'/0'/0/${index}`,
  );
}

async function main(): Promise<void> {
  let anvil: ChildProcess | undefined;
  try {
    anvil = spawn(anvilBin, ["--port", "8545", "--chain-id", String(CHAIN_ID), "--silent"], {
      stdio: "ignore",
    });
    const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
    await waitForRpc(provider);
    const deployer = walletAt(0).connect(provider);
    const bundler = walletAt(1).connect(provider);
    const accountOwner = walletAt(2).connect(provider);
    const beneficiary = walletAt(3).connect(provider);
    const sponsorSigner = walletAt(4).connect(provider);

    const entryPointArtifact = artifact("EntryPoint");
    const factoryArtifact = artifact("SimpleAccountFactory");
    const paymasterArtifact = artifact("VerifyingPaymaster");
    const accountArtifact = artifact("SimpleAccount");

    const entryPoint = await new ContractFactory(
      entryPointArtifact.abi,
      entryPointArtifact.bytecode,
      deployer,
    ).deploy();
    await entryPoint.waitForDeployment();
    const entryPointAddress = await entryPoint.getAddress();

    const factory = await new ContractFactory(
      factoryArtifact.abi,
      factoryArtifact.bytecode,
      deployer,
    ).deploy(entryPointAddress);
    await factory.waitForDeployment();

    const paymaster = await new ContractFactory(
      paymasterArtifact.abi,
      paymasterArtifact.bytecode,
      deployer,
    ).deploy(entryPointAddress, sponsorSigner.address);
    await paymaster.waitForDeployment();
    const paymasterAddress = await paymaster.getAddress();

    const accountSalt = 1n;
    await (await factory.createAccount(accountOwner.address, accountSalt)).wait();
    const accountAddress = (await factory.getFunction("getAddress")(
      accountOwner.address,
      accountSalt,
    )) as string;

    // A tiny contract whose runtime is "PUSH1 0 PUSH1 0 REVERT"; used for the
    // included-failure case without needing a Solidity compiler in this script.
    const failingInitCode = "0x600580600b6000396000f360006000fd";
    const failingDeploy = await deployer.sendTransaction({ data: failingInitCode });
    const failingReceipt = await failingDeploy.wait();
    const failingTarget = failingReceipt?.contractAddress;
    if (failingTarget === null || failingTarget === undefined) {
      throw new Error("failed to deploy the reverting target contract");
    }

    const sponsorDeposit = parseEther("1");
    await (await paymaster.deposit({ value: sponsorDeposit })).wait();

    const entryPointContract = new Contract(entryPointAddress, entryPointArtifact.abi, provider);
    const factoryContract = new Contract(await factory.getAddress(), factoryArtifact.abi, provider);
    const paymasterContract = new Contract(paymasterAddress, paymasterArtifact.abi, provider);
    const accountContract = new Contract(accountAddress, accountArtifact.abi, provider);
    const abiCoder = AbiCoder.defaultAbiCoder();

    const GAS = {
      verificationGasLimit: 400_000n,
      callGasLimit: 200_000n,
      paymasterVerificationGasLimit: 200_000n,
      paymasterPostOpGasLimit: 80_000n,
      preVerificationGas: 80_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 3_000_000_000n,
    };

    interface BundleResult {
      outerTxHash: string;
      outerTxStatus: number;
      gasUsed: string;
      blockNumber: number;
      userOpHash: string;
      event: {
        success: boolean;
        actualGasCost: string;
        actualGasUsed: string;
        nonce: string;
      } | null;
      revertReason: string | null;
    }

    async function buildAndSend(params: {
      target: string;
      data: string;
      nonce?: bigint;
      validUntil: bigint;
      validAfter: bigint;
    }): Promise<BundleResult> {
      const nonce = params.nonce ?? (await entryPointContract.getNonce(accountAddress, 0)) as bigint;
      const accountGasLimits = concat([
        toBeHex(GAS.verificationGasLimit, 16),
        toBeHex(GAS.callGasLimit, 16),
      ]);
      const gasFees = concat([
        toBeHex(GAS.maxPriorityFeePerGas, 16),
        toBeHex(GAS.maxFeePerGas, 16),
      ]);
      const callData = accountContract.interface.encodeFunctionData("execute", [
        params.target,
        0n,
        params.data,
      ]);
      const timestampData = abiCoder.encode(["uint48", "uint48"], [params.validUntil, params.validAfter]);
      const paymasterHeader = concat([
        paymasterAddress,
        toBeHex(GAS.paymasterVerificationGasLimit, 16),
        toBeHex(GAS.paymasterPostOpGasLimit, 16),
        timestampData,
      ]);
      const baseUserOp = {
        sender: accountAddress,
        nonce,
        initCode: "0x",
        callData,
        accountGasLimits,
        preVerificationGas: GAS.preVerificationGas,
        gasFees,
        paymasterAndData: concat([paymasterHeader, new Uint8Array(65)]),
        signature: "0x",
      };
      const paymasterHash = (await paymasterContract.getFunction("getHash")(
        baseUserOp,
        params.validUntil,
        params.validAfter,
      )) as string;
      const sponsorSignature = await sponsorSigner.signMessage(getBytes(paymasterHash));
      const paymasterAndData = concat([paymasterHeader, sponsorSignature]);
      const userOpWithoutSig = { ...baseUserOp, paymasterAndData };
      const userOpHash = (await entryPointContract.getFunction("getUserOpHash")(
        userOpWithoutSig,
      )) as string;
      const accountSignature = await accountOwner.signMessage(getBytes(userOpHash));
      const userOp = { ...userOpWithoutSig, signature: accountSignature };

      const handleOpsData = entryPointContract.interface.encodeFunctionData("handleOps", [
        [userOp],
        beneficiary.address,
      ]);
      let revertReason: string | null = null;
      try {
        await provider.call({ to: entryPointAddress, data: handleOpsData, from: bundler.address });
      } catch (error) {
        const candidate = error as { data?: string; info?: { error?: { data?: string } } };
        const revertData = candidate.data ?? candidate.info?.error?.data;
        if (revertData !== undefined) {
          try {
            const parsed = entryPointContract.interface.parseError(revertData);
            if (parsed !== null) {
              revertReason = `${parsed.name}(${parsed.args.map((arg: unknown) => String(arg)).join(",")})`;
            }
          } catch {
            // not a known EntryPoint custom error
          }
        }
        revertReason ??= error instanceof Error ? error.message.slice(0, 200) : String(error);
      }
      const tx = await bundler.sendTransaction({
        to: entryPointAddress,
        data: handleOpsData,
        gasLimit: 3_000_000n,
      });
      let receipt: TransactionReceipt;
      try {
        receipt = (await tx.wait()) as TransactionReceipt;
      } catch (waitError) {
        const revertedReceipt = (waitError as { receipt?: TransactionReceipt }).receipt;
        if (revertedReceipt === undefined) {
          throw waitError;
        }
        receipt = revertedReceipt;
      }
      void tx;
      let event: BundleResult["event"] = null;
      for (const log of receipt.logs) {
        try {
          const parsed = entryPointContract.interface.parseLog(log);
          if (parsed !== null && parsed.name === "UserOperationEvent") {
            event = {
              success: parsed.args["success"] as boolean,
              actualGasCost: (parsed.args["actualGasCost"] as bigint).toString(),
              actualGasUsed: (parsed.args["actualGasUsed"] as bigint).toString(),
              nonce: (parsed.args["nonce"] as bigint).toString(),
            };
            break;
          }
        } catch {
          // unrelated log
        }
      }
      return {
        outerTxHash: receipt.hash,
        outerTxStatus: receipt.status ?? 0,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
        userOpHash,
        event,
        revertReason,
      };
    }

    const cases: Array<Record<string, unknown>> = [];
    const block = await provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
    const validUntil = now + 3600n;
    const validAfter = 0n;

    async function recordCase(params: {
      caseId: string;
      kind: string;
      expectedEvent: boolean;
      expectedSuccess: boolean | null;
      expectedStatus: number;
      target: string;
      targetData: string;
      targetLabel: string;
    }): Promise<void> {
      const depositBefore = (await entryPointContract.balanceOf(paymasterAddress)) as bigint;
      const accountBalanceBefore = await provider.getBalance(accountAddress);
      const result = await buildAndSend({
        target: params.target,
        data: params.targetData,
        validUntil,
        validAfter,
      });
      const depositAfter = (await entryPointContract.balanceOf(paymasterAddress)) as bigint;
      const accountBalanceAfter = await provider.getBalance(accountAddress);
      const depositDelta = depositAfter - depositBefore;
      const paymasterPays = result.event !== null && BigInt(result.event.actualGasCost) > 0n;
      const pass =
        result.outerTxStatus === params.expectedStatus &&
        (params.expectedEvent ? result.event !== null : result.event === null) &&
        (params.expectedSuccess === null || result.event?.success === params.expectedSuccess) &&
        (params.kind === "sponsored-success" || params.kind === "included-failure"
          ? paymasterPays && depositDelta < 0n
          : depositDelta === 0n && !paymasterPays);
      cases.push({
        caseId: params.caseId,
        kind: params.kind,
        target: params.target,
        targetLabel: params.targetLabel,
        userOpHashPresent: result.event !== null,
        userOpHash: result.userOpHash,
        outerTxHash: result.outerTxHash,
        outerTxStatus: result.outerTxStatus,
        gasUsed: result.gasUsed,
        blockNumber: result.blockNumber,
        userOperationEvent: result.event,
        userChargeBase: (accountBalanceAfter - accountBalanceBefore).toString(),
        paymasterDepositBeforeBase: depositBefore.toString(),
        paymasterDepositAfterBase: depositAfter.toString(),
        paymasterDepositDeltaBase: depositDelta.toString(),
        sponsorPaid: paymasterPays,
        permit: {
          validUntil: validUntil.toString(),
          validAfter: validAfter.toString(),
          verifyingSigner: sponsorSigner.address,
        },
        revertReason: result.revertReason,
        expected: {
          outerTxStatus: params.expectedStatus,
          userOperationEvent: params.expectedEvent,
          success: params.expectedSuccess,
          depositDeltaSign: params.kind === "exhausted-sponsor" ? "zero" : "negative",
        },
        pass,
      });
      console.log(
        `${pass ? "PASS" : "FAIL"} ${params.caseId} (${params.kind}) tx=${result.outerTxHash.slice(0, 10)}… status=${result.outerTxStatus} event=${result.event === null ? "absent" : `success=${result.event.success} cost=${result.event.actualGasCost}`} depositDelta=${depositDelta}`,
      );
    }

    // Case 1: sponsored success — plain zero-value call to a fresh address.
    await recordCase({
      caseId: "A04-C01",
      kind: "sponsored-success",
      expectedEvent: true,
      expectedSuccess: true,
      expectedStatus: 1,
      target: "0x000000000000000000000000000000000000dEaD",
      targetData: "0x",
      targetLabel: "zero-value transfer",
    });

    // Case 2: included failure — the inner call reverts but the sponsor still pays.
    await recordCase({
      caseId: "A04-C02",
      kind: "included-failure",
      expectedEvent: true,
      expectedSuccess: false,
      expectedStatus: 1,
      target: failingTarget,
      targetData: "0x",
      targetLabel: "always-reverting target contract",
    });

    // Case 3: exhausted sponsor — withdraw the deposit, then validation fails.
    const remainingDeposit = (await entryPointContract.balanceOf(paymasterAddress)) as bigint;
    if (remainingDeposit > 0n) {
      await (await paymaster.withdrawTo(deployer.address, remainingDeposit)).wait();
    }
    await recordCase({
      caseId: "A04-C03",
      kind: "exhausted-sponsor",
      expectedEvent: false,
      expectedSuccess: null,
      expectedStatus: 0,
      target: "0x000000000000000000000000000000000000dEaD",
      targetData: "0x",
      targetLabel: "zero-value transfer after deposit withdrawal",
    });

    const passed = cases.every((item) => item["pass"] === true);
    const evidence = {
      schemaVersion: "1.0.0",
      reportId: "A04-aa-receipts",
      packId: "A04-account-abstraction",
      generatedBy: "pnpm aa:scenario",
      chain: {
        chainId: CHAIN_ID,
        rpc: "http://127.0.0.1:8545",
        runtime: "anvil (local, ephemeral)",
      },
      contracts: {
        entryPoint: entryPointAddress,
        entryPointArtifact: "@account-abstraction/contracts@0.7.0 EntryPoint",
        accountFactory: await factory.getAddress(),
        account: accountAddress,
        paymaster: paymasterAddress,
        paymasterArtifact: "@account-abstraction/contracts@0.7.0 VerifyingPaymaster",
        bundler: bundler.address,
        beneficiary: beneficiary.address,
        sponsorSigner: sponsorSigner.address,
      },
      cases,
      summary: {
        cases: cases.length,
        passed: passed ? cases.length : cases.filter((item) => item["pass"] === true).length,
        passedAll: passed,
      },
    };
    const outPath = join(repoRoot, "evidence/a04/aa-receipts.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`wrote evidence/a04/aa-receipts.json; passed=${passed}`);
    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    anvil?.kill("SIGKILL");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
