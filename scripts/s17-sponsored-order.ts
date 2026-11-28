/**
 * S17 / SET-03 sponsored actual order.
 *
 * Deploys the pinned ERC-4337 v0.7 EntryPoint, SimpleAccountFactory, a target- and
 * method-scoped expiring permit paymaster and the retail order entry gateway on the
 * controlled OP Stack L2. Bundles real user operations through the EntryPoint:
 * approval + G01 spot fill (sponsored success), an expiring order that reverts inside an
 * included bundle, pre-submission permit budget/expiry rejections, and the recovery of an
 * already-mined userOp after a simulated lost response. The user account never pays gas.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  MaxUint256,
  concat,
  getBytes,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  type TransactionReceipt,
} from "ethers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s17");
const abiDir = join(repoRoot, "contracts", "abi");
const runDir = process.env.DEVNET_LOCAL_RUN_DIR ?? join(repoRoot, ".devnet-local", "run");
const envPath = join(runDir, "env.json");
const CHAIN_ID = 16584;
const AA_ROOT = join(repoRoot, "node_modules", "@account-abstraction", "contracts");
const CASH_UNIT = 1_000_000n;
const SPOT_UNIT = 1_000_000_000_000_000_000n;
const MAX_FEE_PER_GAS = 3_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;
const VERIFICATION_GAS_LIMIT = 500_000n;
const CALL_GAS_LIMIT = 300_000n;
const PAYMASTER_VERIFICATION_GAS_LIMIT = 250_000n;
const PAYMASTER_POST_OP_GAS_LIMIT = 100_000n;
const PRE_VERIFICATION_GAS = 100_000n;

type AnyContract = Record<string, any>;
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path: string): string => sha256(readFileSync(path));
const artifact = (path: string): { abi: unknown[]; bytecode: string } => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { abi: unknown[] | string; bytecode: string | { object: string } };
  return {
    abi: typeof parsed.abi === "string" ? JSON.parse(parsed.abi) as unknown[] : parsed.abi,
    bytecode: typeof parsed.bytecode === "string" ? parsed.bytecode : parsed.bytecode.object,
  };
};
function deterministicWallet(label: string, provider: JsonRpcProvider): Wallet {
  return new Wallet(keccak256(toUtf8Bytes(`eurorollup-s17-${label}`)), provider);
}
interface ChainEnv { l1Rpc: string; l2Rpc: string; portal: string; deployerKey: string }
async function waitForDevnet(): Promise<ChainEnv> {
  const started = Date.now();
  for (;;) {
    if (existsSync(envPath)) {
      try {
        const env = JSON.parse(readFileSync(envPath, "utf8")) as { l1Rpc: string; l2Rpc: string; portal: string; keys: { deployer: string } };
        const provider = new JsonRpcProvider(env.l2Rpc, undefined, { staticNetwork: true });
        if (Number((await provider.getNetwork()).chainId) === CHAIN_ID) return { l1Rpc: env.l1Rpc, l2Rpc: env.l2Rpc, portal: env.portal, deployerKey: env.keys.deployer };
      } catch {
        // devnet still starting
      }
    }
    if (Date.now() - started > 600_000) throw new Error("timed out waiting for the controlled devnet L2");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
function extractErrorData(error: unknown): string | null {
  const candidate = error as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  for (const value of [candidate.data, candidate.info?.error?.data, candidate.error?.data]) {
    if (typeof value === "string" && value.startsWith("0x")) return value;
  }
  return null;
}

interface PermitRecord {
  account: string;
  target: string;
  selector: string;
  chainId: number;
  permitNonce: number;
  validUntil: number;
  maxCost: string;
}
interface UserOpResult {
  label: string;
  permit: PermitRecord;
  permitHash: string;
  userOpHash: string;
  simulationRevert: string | null;
  submitted: boolean;
  outerTxHash: string | null;
  outerTxStatus: number | null;
  outerGasUsed: string | null;
  blockNumber: number | null;
  userOperationEvent: { success: boolean; actualGasCost: string; actualGasUsed: string } | null;
  userChargeWei: string;
  sponsorDepositBefore: string;
  sponsorDepositAfter: string;
  sponsorDepositDelta: string;
  beneficiaryBefore: string;
  beneficiaryAfter: string;
  beneficiaryDelta: string;
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(abiDir, { recursive: true });
  const env = await waitForDevnet();
  const provider = new JsonRpcProvider(env.l2Rpc, undefined, { staticNetwork: true });
  const deployer = new Wallet(env.deployerKey, provider);
  const accountOwner = deterministicWallet("account-owner", provider);
  const sponsor = deterministicWallet("sponsor", provider);
  const bundler = deterministicWallet("bundler", provider);
  const beneficiary = deterministicWallet("beneficiary", provider);
  const dealer = deterministicWallet("dealer", provider);
  const feeRecipient = deterministicWallet("fee-recipient", provider);
  const stranger = deterministicWallet("stranger", provider);
  const wallets = [accountOwner, sponsor, bundler, beneficiary, dealer, feeRecipient, stranger];

  if ((await provider.getBalance(deployer.address)) < 10n ** 18n) {
    const l1Provider = new JsonRpcProvider(env.l1Rpc, undefined, { staticNetwork: true });
    const portal = new Contract(env.portal, ["function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable"], new Wallet(env.deployerKey, l1Provider));
    const deposit = await portal.depositTransaction(deployer.address, 10n * 10n ** 18n, 200_000n, false, "0x", { value: 10n * 10n ** 18n });
    await deposit.wait();
    for (let waited = 0; (await provider.getBalance(deployer.address)) < 10n ** 18n; waited += 3_000) {
      if (waited > 600_000) throw new Error("timed out waiting for bridged L2 gas");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  const fundingTxs: Array<{ label: string; address: string; txHash: string }> = [];
  for (const [index, wallet] of wallets.entries()) {
    if ((await provider.getBalance(wallet.address)) < 2n * 10n ** 17n) {
      const tx = await deployer.sendTransaction({ to: wallet.address, value: 10n ** 18n });
      await tx.wait();
      fundingTxs.push({ label: `wallet-${String(index)}`, address: wallet.address, txHash: tx.hash });
    }
  }

  const contractsOut = join(repoRoot, "contracts", "out");
  const artifacts: Record<string, { abi: unknown[]; bytecode: string }> = {
    EntryPoint: artifact(join(AA_ROOT, "artifacts", "EntryPoint.json")),
    SimpleAccountFactory: artifact(join(AA_ROOT, "artifacts", "SimpleAccountFactory.json")),
    SimpleAccount: artifact(join(AA_ROOT, "artifacts", "SimpleAccount.json")),
    ScopedSponsorshipPaymaster: artifact(join(contractsOut, "ScopedSponsorshipPaymaster.sol", "ScopedSponsorshipPaymaster.json")),
    RetailOrderEntry: artifact(join(contractsOut, "RetailOrderEntry.sol", "RetailOrderEntry.json")),
    Token: artifact(join(contractsOut, "Token.sol", "Token.json")),
    RestrictedShare: artifact(join(contractsOut, "RestrictedShare.sol", "RestrictedShare.json")),
    Escrow: artifact(join(contractsOut, "Escrow.sol", "Escrow.json")),
    DvPSettlement: artifact(join(contractsOut, "DvPSettlement.sol", "DvPSettlement.json")),
  };
  for (const [name, value] of Object.entries(artifacts)) {
    if (["Token", "RestrictedShare", "Escrow", "DvPSettlement", "ScopedSponsorshipPaymaster", "RetailOrderEntry"].includes(name)) {
      writeFileSync(join(abiDir, `${name}.json`), `${json(value.abi)}\n`);
    }
  }

  interface Deployment { name: string; contract: string; address: string; txHash: string; blockNumber: number; codeHash: string; abiSha256: string | null }
  const deployments: Deployment[] = [];
  const deploy = async (label: string, contractName: keyof typeof artifacts, args: readonly unknown[]): Promise<AnyContract> => {
    const factory = new ContractFactory(artifacts[contractName]!.abi, artifacts[contractName]!.bytecode, deployer);
    const contract = (await factory.deploy(...args)) as unknown as AnyContract;
    const receipt = (await contract.deploymentTransaction().wait())!;
    const address = await contract.getAddress();
    const abiPath = join(abiDir, `${String(contractName)}.json`);
    deployments.push({
      name: label,
      contract: String(contractName),
      address,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      codeHash: keccak256(await provider.getCode(address)),
      abiSha256: existsSync(abiPath) ? sha256File(abiPath) : null,
    });
    return contract;
  };

  const entryPoint = await deploy("entryPoint", "EntryPoint", []);
  const entryPointAddress = await entryPoint.getAddress();
  const factory = await deploy("simpleAccountFactory", "SimpleAccountFactory", [entryPointAddress]);
  const paymaster = await deploy("paymaster", "ScopedSponsorshipPaymaster", [entryPointAddress, sponsor.address]);
  const paymasterAddress = await paymaster.getAddress();
  const cash = await deploy("cash", "Token", ["Demo euro cash", "dEUR", 6]);
  const spot = await deploy("spot", "Token", ["Test wrapped ETH", "tWETH", 18]);
  const fund = await deploy("fund", "RestrictedShare", ["Fictional euro fund unit", "eFUND", 6, deployer.address]);
  const escrow = await deploy("escrow", "Escrow", [await cash.getAddress()]);
  const settlement = await deploy("settlement", "DvPSettlement", [
    await cash.getAddress(),
    await spot.getAddress(),
    await fund.getAddress(),
    await escrow.getAddress(),
    feeRecipient.address,
    deployer.address,
  ]);
  const settlementAddress = await settlement.getAddress();
  const entry = await deploy("orderEntry", "RetailOrderEntry", [settlementAddress]);
  const entryAddress = await entry.getAddress();
  const escrowAddress = await escrow.getAddress();

  const transactions: Array<{ stage: string; label: string; txHash: string; blockNumber: number; status: number }> = [];
  const send = async (stage: string, label: string, call: Promise<any>): Promise<void> => {
    const tx = await call;
    const receipt = (await tx.wait())!;
    transactions.push({ stage, label, txHash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status ?? 0 });
  };
  await send("wiring", "escrow.setOperator(settlement)", escrow.setOperator(settlementAddress));
  await send("wiring", "settlement.setOperator(order-entry)", settlement.setOperator(entryAddress));

  // Account deployment and funding (sponsor pays only for the permit deposit; the user
  // account stays at zero native balance).
  const accountSalt = 7n;
  await send("account", "factory.createAccount(owner, salt)", factory.createAccount(accountOwner.address, accountSalt));
  const accountAddress = (await factory.getFunction("getAddress")(accountOwner.address, accountSalt)) as string;
  await send("account", "cash.mint(account, 1000 dEUR)", cash.mint(accountAddress, 1_000n * CASH_UNIT));
  await send("account", "spot.mint(dealer, 1 tWETH)", spot.mint(dealer.address, 1n * SPOT_UNIT));
  await send("account", "dealer approves settlement for tWETH", spot.connect(dealer).approve(settlementAddress, MaxUint256));
  await send("sponsor", "paymaster.deposit(0.2 ETH)", paymaster.connect(sponsor).deposit({ value: 2n * 10n ** 17n }));

  const entryPointContract = new Contract(entryPointAddress, artifacts.EntryPoint!.abi, provider);
  const factoryContract = new Contract(await factory.getAddress(), artifacts.SimpleAccountFactory!.abi, provider);
  const paymasterContract = new Contract(paymasterAddress, artifacts.ScopedSponsorshipPaymaster!.abi, provider);
  const accountContract = new Contract(accountAddress, artifacts.SimpleAccount!.abi, provider);
  const accountCode = await provider.getCode(accountAddress);
  console.log(`account=${accountAddress} codeBytes=${String(accountCode.length)} factory=${await factory.getAddress()} entryPoint=${entryPointAddress} paymaster=${paymasterAddress} orderEntry=${entryAddress} settlement=${settlementAddress}`);
  console.log(`accountOwner=${accountOwner.address} ownerSlot=${String(await accountContract.owner())}`);
  const cashContract = new Contract(await cash.getAddress(), artifacts.Token!.abi, provider);
  const entryContract = new Contract(entryAddress, artifacts.RetailOrderEntry!.abi, provider);
  const abiCoder = AbiCoder.defaultAbiCoder();
  const permitType = "tuple(address account,address target,bytes4 selector,uint256 chainId,uint256 permitNonce,uint64 validUntil,uint256 maxCost)";
  const maxCostBase = (VERIFICATION_GAS_LIMIT + CALL_GAS_LIMIT + PAYMASTER_VERIFICATION_GAS_LIMIT + PAYMASTER_POST_OP_GAS_LIMIT + PRE_VERIFICATION_GAS) * MAX_FEE_PER_GAS;

  const permits: Array<PermitRecord & { label: string; permitHash: string; sponsorSignature: string }> = [];
  async function permitFor(params: {
    label: string;
    target: string;
    selector: string;
    validUntil: number;
    maxCost: bigint;
    permitNonce: number;
  }): Promise<PermitRecord & { label: string; permitHash: string; sponsorSignature: string }> {
    const onchainPermit = {
      account: accountAddress,
      target: params.target,
      selector: params.selector,
      chainId: CHAIN_ID,
      permitNonce: params.permitNonce,
      validUntil: params.validUntil,
      maxCost: params.maxCost,
    };
    const digest = (await paymasterContract.permitDigest(onchainPermit)) as string;
    const sponsorSignature = await sponsor.signMessage(getBytes(digest));
    const record = { label: params.label, ...onchainPermit, maxCost: params.maxCost.toString(), permitHash: digest, sponsorSignature };
    permits.push(record);
    return record;
  }

  let latestBlock = await provider.getBlock("latest");
  const now = Number(latestBlock!.timestamp);
  const approveSelector = cashContract.interface.getFunction("approve")!.selector as string;
  const submitSelector = entryContract.interface.getFunction("submitSpotOrder")!.selector as string;

  const results: UserOpResult[] = [];
  async function runUserOp(params: {
    label: string;
    permit: PermitRecord & { label: string; permitHash: string; sponsorSignature: string };
    innerTarget: string;
    innerData: string;
    submit: boolean;
  }): Promise<UserOpResult> {
    const nonce = (await entryPointContract.getNonce(accountAddress, 0)) as bigint;
    const callData = accountContract.interface.encodeFunctionData("execute", [params.innerTarget, 0n, params.innerData]);
    const accountGasLimits = concat([toBeHex(VERIFICATION_GAS_LIMIT, 16), toBeHex(CALL_GAS_LIMIT, 16)]);
    const gasFees = concat([toBeHex(MAX_PRIORITY_FEE_PER_GAS, 16), toBeHex(MAX_FEE_PER_GAS, 16)]);
    const permitData = abiCoder.encode([permitType, "bytes"], [
      { ...params.permit, maxCost: BigInt(params.permit.maxCost) },
      params.permit.sponsorSignature,
    ]);
    const paymasterAndData = concat([
      paymasterAddress,
      toBeHex(PAYMASTER_VERIFICATION_GAS_LIMIT, 16),
      toBeHex(PAYMASTER_POST_OP_GAS_LIMIT, 16),
      permitData,
    ]);
    const userOp = {
      sender: accountAddress,
      nonce,
      initCode: "0x",
      callData,
      accountGasLimits,
      preVerificationGas: PRE_VERIFICATION_GAS,
      gasFees,
      paymasterAndData,
      signature: "0x",
    };
    const userOpHash = (await entryPointContract.getUserOpHash(userOp)) as string;
    const accountSignature = await accountOwner.signMessage(getBytes(userOpHash));
    const signedOp = { ...userOp, signature: accountSignature };
    const handleOpsData = entryPointContract.interface.encodeFunctionData("handleOps", [[signedOp], beneficiary.address]);
    let simulationRevert: string | null = null;
    try {
      await provider.call({ to: entryPointAddress, data: handleOpsData, from: bundler.address });
    } catch (error) {
      const data = extractErrorData(error);
      simulationRevert = data ?? (error instanceof Error ? error.message.slice(0, 500) : String(error));
      console.log(`[debug] simulation error data=${String(data)} accountCode=${String((await provider.getCode(accountAddress)).length)} nonce=${nonce.toString()} sender=${accountAddress}`);
      try {
        const parsed = entryPointContract.interface.parseError(data ?? "");
        if (parsed !== null) simulationRevert = `${parsed.name}(${parsed.args.map((value: unknown) => String(value)).join(",")})`;
      } catch {
        // keep raw data
      }
    }
    const depositBefore = (await entryPointContract.balanceOf(paymasterAddress)) as bigint;
    const beneficiaryBefore = await provider.getBalance(beneficiary.address);
    const accountBalanceBefore = await provider.getBalance(accountAddress);
    let receipt: TransactionReceipt | null = null;
    if (params.submit) {
      const tx = await bundler.sendTransaction({ to: entryPointAddress, data: handleOpsData, gasLimit: 3_500_000n });
      try {
        receipt = (await tx.wait()) as TransactionReceipt;
      } catch (waitError) {
        receipt = (waitError as { receipt?: TransactionReceipt }).receipt ?? null;
        if (receipt === null) throw waitError;
      }
    }
    const depositAfter = (await entryPointContract.balanceOf(paymasterAddress)) as bigint;
    const beneficiaryAfter = await provider.getBalance(beneficiary.address);
    const accountBalanceAfter = await provider.getBalance(accountAddress);
    let event: UserOpResult["userOperationEvent"] = null;
    if (receipt !== null) {
      for (const log of receipt.logs) {
        try {
          const parsed = entryPointContract.interface.parseLog(log);
          if (parsed !== null && parsed.name === "UserOperationEvent") {
            event = {
              success: parsed.args["success"] as boolean,
              actualGasCost: (parsed.args["actualGasCost"] as bigint).toString(),
              actualGasUsed: (parsed.args["actualGasUsed"] as bigint).toString(),
            };
            break;
          }
        } catch {
          // not an EntryPoint event
        }
      }
    }
    const result: UserOpResult = {
      label: params.label,
      permit: {
        account: params.permit.account,
        target: params.permit.target,
        selector: params.permit.selector,
        chainId: params.permit.chainId,
        permitNonce: params.permit.permitNonce,
        validUntil: params.permit.validUntil,
        maxCost: params.permit.maxCost.toString(),
      },
      permitHash: params.permit.permitHash,
      userOpHash,
      simulationRevert,
      submitted: params.submit,
      outerTxHash: receipt?.hash ?? null,
      outerTxStatus: receipt?.status ?? null,
      outerGasUsed: receipt?.gasUsed?.toString() ?? null,
      blockNumber: receipt?.blockNumber ?? null,
      userOperationEvent: event,
      userChargeWei: (accountBalanceAfter - accountBalanceBefore).toString(),
      sponsorDepositBefore: depositBefore.toString(),
      sponsorDepositAfter: depositAfter.toString(),
      sponsorDepositDelta: (depositAfter - depositBefore).toString(),
      beneficiaryBefore: beneficiaryBefore.toString(),
      beneficiaryAfter: beneficiaryAfter.toString(),
      beneficiaryDelta: (beneficiaryAfter - beneficiaryBefore).toString(),
    };
    results.push(result);
    console.log(`${params.label}: submitted=${String(params.submit)} status=${String(result.outerTxStatus)} event=${event === null ? "absent" : `success=${String(event.success)} cost=${event.actualGasCost}`} sim=${simulationRevert?.slice(0, 80) ?? "ok"}`);
    return result;
  }

  // 1. Sponsored approval: permit is scoped to the dEUR contract and the approve method.
  const approvePermit = await permitFor({
    label: "approve-permit",
    target: await cash.getAddress(),
    selector: approveSelector,
    validUntil: now + 3_600,
    maxCost: maxCostBase,
    permitNonce: 1,
  });
  const approveResult = await runUserOp({
    label: "sponsored-approval",
    permit: approvePermit,
    innerTarget: await cash.getAddress(),
    innerData: cashContract.interface.encodeFunctionData("approve", [settlementAddress, MaxUint256]),
    submit: true,
  });
  if (approveResult.userOperationEvent?.success !== true) throw new Error("sponsored approval was not successful");

  // 2. Sponsored actual order: the G01 spot fill, scoped to the order entry method.
  const orderId = keccak256(toUtf8Bytes("G01-SPOT-01"));
  const orderPermit = await permitFor({
    label: "g01-order-permit",
    target: entryAddress,
    selector: submitSelector,
    validUntil: now + 3_600,
    maxCost: maxCostBase,
    permitNonce: 2,
  });
  const orderDeadline = BigInt(now + 3_600);
  const orderResult = await runUserOp({
    label: "sponsored-fill",
    permit: orderPermit,
    innerTarget: entryAddress,
    innerData: entryContract.interface.encodeFunctionData("submitSpotOrder", [orderId, dealer.address, 200n * CASH_UNIT, 50_000n, SPOT_UNIT / 10n, orderDeadline]),
    submit: true,
  });
  if (orderResult.userOperationEvent?.success !== true) throw new Error("sponsored fill was not successful");
  const afterFill = {
    accountCash: (await cash.balanceOf(accountAddress)).toString(),
    accountSpot: (await spot.balanceOf(accountAddress)).toString(),
    dealerCash: (await cash.balanceOf(dealer.address)).toString(),
    dealerSpot: (await spot.balanceOf(dealer.address)).toString(),
    feeCash: (await cash.balanceOf(feeRecipient.address)).toString(),
    accountNative: (await provider.getBalance(accountAddress)).toString(),
  };

  // 3. Included revert: a second order with an expired quote is bundled and paid for by
  // the sponsor, but the inner order entry call fails and no balances move.
  const expiredOrderId = keccak256(toUtf8Bytes("G01-EXPIRED-01"));
  const expiredPermit = await permitFor({
    label: "expired-order-permit",
    target: entryAddress,
    selector: submitSelector,
    validUntil: now + 3_600,
    maxCost: maxCostBase,
    permitNonce: 3,
  });
  const includedRevert = await runUserOp({
    label: "included-revert",
    permit: expiredPermit,
    innerTarget: entryAddress,
    innerData: entryContract.interface.encodeFunctionData("submitSpotOrder", [expiredOrderId, dealer.address, 10n * CASH_UNIT, 50_000n, SPOT_UNIT / 100n, BigInt(now - 10)]),
    submit: true,
  });
  const afterIncludedRevert = {
    accountCash: (await cash.balanceOf(accountAddress)).toString(),
    accountSpot: (await spot.balanceOf(accountAddress)).toString(),
    dealerCash: (await cash.balanceOf(dealer.address)).toString(),
    dealerSpot: (await spot.balanceOf(dealer.address)).toString(),
    feeCash: (await cash.balanceOf(feeRecipient.address)).toString(),
  };

  // 4. Pre-submission budget rejection: permit cap below the required max cost. The
  // bundler simulation must fail and nothing is submitted.
  const budgetPermit = await permitFor({
    label: "budget-permit",
    target: entryAddress,
    selector: submitSelector,
    validUntil: now + 3_600,
    maxCost: 1_000n,
    permitNonce: 4,
  });
  const budgetRejection = await runUserOp({
    label: "budget-rejection",
    permit: budgetPermit,
    innerTarget: entryAddress,
    innerData: entryContract.interface.encodeFunctionData("submitSpotOrder", [keccak256(toUtf8Bytes("G01-BUDGET-01")), dealer.address, 1n * CASH_UNIT, 0n, SPOT_UNIT / 1_000n, orderDeadline]),
    submit: false,
  });
  if (budgetRejection.simulationRevert === null) throw new Error("budget rejection was not rejected during simulation");

  // 5. Pre-submission expiry rejection: permit already expired.
  const expiredPermit2 = await permitFor({
    label: "expired-permit",
    target: entryAddress,
    selector: submitSelector,
    validUntil: now - 1,
    maxCost: maxCostBase,
    permitNonce: 5,
  });
  const expiryRejection = await runUserOp({
    label: "permit-expiry-rejection",
    permit: expiredPermit2,
    innerTarget: entryAddress,
    innerData: entryContract.interface.encodeFunctionData("submitSpotOrder", [keccak256(toUtf8Bytes("G01-EXPIRED-PERMIT")), dealer.address, 1n * CASH_UNIT, 0n, SPOT_UNIT / 1_000n, orderDeadline]),
    submit: false,
  });
  if (expiryRejection.simulationRevert === null) throw new Error("expired permit was not rejected during simulation");

  // 6. Lost response: recover the existing UserOperationEvent/receipt from chain logs
  // instead of resubmitting the request, then prove a repeated order id cannot move
  // money a second time.
  const orderStartBlock = deployments.find((entry) => entry.name === "orderEntry")!.blockNumber;
  const events = await entryPointContract.queryFilter(
    entryPointContract.filters.UserOperationEvent(orderResult.userOpHash),
    orderStartBlock,
    "latest",
  );
  if (events.length !== 1) throw new Error(`expected one UserOperationEvent for the recovered op, got ${String(events.length)}`);
  const recoveredEvent = events[0]!;
  const recoveredTx = await provider.getTransaction(recoveredEvent.transactionHash);
  const recoveredReceipt = await provider.getTransactionReceipt(recoveredEvent.transactionHash);
  const recoveredParsed = entryPointContract.interface.parseLog(recoveredEvent as unknown as { topics: string[]; data: string })!;
  const recovered = {
    method: "EntryPoint UserOperationEvent log lookup by userOpHash",
    userOpHash: orderResult.userOpHash,
    foundTxHash: recoveredEvent.transactionHash,
    originalTxHash: orderResult.outerTxHash,
    sameTransaction: recoveredEvent.transactionHash === orderResult.outerTxHash,
    receiptStatus: recoveredReceipt?.status ?? null,
    blockNumber: recoveredReceipt?.blockNumber ?? null,
    eventSuccess: recoveredParsed.args["success"] as boolean,
    eventActualGasCost: (recoveredParsed.args["actualGasCost"] as bigint).toString(),
    accountCashUnchanged: (await cash.balanceOf(accountAddress)).toString(),
    accountSpotUnchanged: (await spot.balanceOf(accountAddress)).toString(),
    orderSettledOnce: (await entryContract.settledOrders(orderId)) as boolean,
    transactionFromBundler: recoveredTx?.from?.toLowerCase() === bundler.address.toLowerCase(),
  };

  const replayPermit = await permitFor({
    label: "replay-permit",
    target: entryAddress,
    selector: submitSelector,
    validUntil: now + 3_600,
    maxCost: maxCostBase,
    permitNonce: 6,
  });
  const replay = await runUserOp({
    label: "replay-blocked",
    permit: replayPermit,
    innerTarget: entryAddress,
    innerData: entryContract.interface.encodeFunctionData("submitSpotOrder", [orderId, dealer.address, 200n * CASH_UNIT, 50_000n, SPOT_UNIT / 10n, orderDeadline]),
    submit: true,
  });
  const replayEffect = {
    replayEventSuccess: replay.userOperationEvent?.success ?? null,
    orderSettledOnce: (await entryContract.settledOrders(orderId)) as boolean,
    accountCash: (await cash.balanceOf(accountAddress)).toString(),
    accountSpot: (await spot.balanceOf(accountAddress)).toString(),
    dealerCash: (await cash.balanceOf(dealer.address)).toString(),
    dealerSpot: (await spot.balanceOf(dealer.address)).toString(),
    feeCash: (await cash.balanceOf(feeRecipient.address)).toString(),
  };

  const canonicalBlock = await provider.getBlockNumber();
  const canonical = await provider.getBlock(canonicalBlock);
  const canonicalBalances = {
    accountCash: (await cash.balanceOf(accountAddress, { blockTag: canonicalBlock })).toString(),
    accountSpot: (await spot.balanceOf(accountAddress, { blockTag: canonicalBlock })).toString(),
    accountNative: (await provider.getBalance(accountAddress, canonicalBlock)).toString(),
    dealerCash: (await cash.balanceOf(dealer.address, { blockTag: canonicalBlock })).toString(),
    dealerSpot: (await spot.balanceOf(dealer.address, { blockTag: canonicalBlock })).toString(),
    feeCash: (await cash.balanceOf(feeRecipient.address, { blockTag: canonicalBlock })).toString(),
    sponsorDeposit: ((await entryPointContract.balanceOf(paymasterAddress, { blockTag: canonicalBlock })) as bigint).toString(),
    beneficiaryNative: (await provider.getBalance(beneficiary.address, canonicalBlock)).toString(),
  };
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const aaPackage = JSON.parse(readFileSync(join(AA_ROOT, "package.json"), "utf8")) as { version: string };
  const artifactsForAbis = ["ScopedSponsorshipPaymaster", "RetailOrderEntry"].map((name) => ({
    name,
    path: `contracts/abi/${name}.json`,
    sha256: sha256File(join(abiDir, `${name}.json`)),
  }));

  const submitted = results.filter((result) => result.submitted);
  const passed =
    orderResult.userOperationEvent?.success === true &&
    approveResult.userOperationEvent?.success === true &&
    includedRevert.submitted === true &&
    includedRevert.userOperationEvent?.success === false &&
    budgetRejection.submitted === false &&
    budgetRejection.simulationRevert !== null &&
    expiryRejection.submitted === false &&
    expiryRejection.simulationRevert !== null &&
    recovered.sameTransaction &&
    recovered.receiptStatus === 1 &&
    recovered.orderSettledOnce &&
    recovered.accountCashUnchanged === "799950000" &&
    recovered.accountSpotUnchanged === (SPOT_UNIT / 10n).toString() &&
    replayEffect.replayEventSuccess === false &&
    replayEffect.orderSettledOnce &&
    replayEffect.accountCash === recovered.accountCashUnchanged &&
    replayEffect.dealerCash === "200000000" &&
    submitted.every((result) => result.userChargeWei === "0") &&
    submitted.filter((result) => result.userOperationEvent !== null).every((result) => BigInt(result.sponsorDepositDelta) === -BigInt(result.userOperationEvent!.actualGasCost)) &&
    submitted.filter((result) => result.userOperationEvent !== null).every((result) => BigInt(result.beneficiaryDelta) === BigInt(result.userOperationEvent!.actualGasCost));

  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "S17-sponsored-order",
    packId: "S17",
    generatedBy: "pnpm s17:run",
    generatedAt: new Date().toISOString(),
    commit,
    chains: { l1ChainId: 11155111, l2ChainId: CHAIN_ID, lane: "controlled local OP Stack devnet (calldata DA development mode)" },
    accountAbstraction: {
      implementation: "ERC-4337 v0.7",
      aaPackageVersion: aaPackage.version,
      entryPointArtifactSha256: sha256File(join(AA_ROOT, "artifacts", "EntryPoint.json")),
      bundler: bundler.address,
      beneficiary: beneficiary.address,
      entryPoint: entryPointAddress,
      entryPointCodeHash: deployments.find((entry) => entry.name === "entryPoint")!.codeHash,
      account: accountAddress,
      accountOwner: accountOwner.address,
      sponsor: sponsor.address,
      paymaster: paymasterAddress,
      note: "The user account keeps zero native balance and pays no gas; the sponsor deposit at the EntryPoint covers the bundle.",
    },
    deployments,
    abis: artifactsForAbis,
    funding: { actorFunding: fundingTxs },
    permits,
    userOperations: results.map((result) => ({
      ...result,
      receipt: result.outerTxHash === null ? null : { txHash: result.outerTxHash, status: result.outerTxStatus, blockNumber: result.blockNumber, gasUsed: result.outerGasUsed },
    })),
    sponsoredFill: { orderId: orderId, deadline: orderDeadline.toString(), afterFill },
    includedRevert: { orderId: expiredOrderId, simulationRevert: includedRevert.simulationRevert, afterIncludedRevert, userOperationEvent: includedRevert.userOperationEvent },
    rejections: {
      budget: { label: budgetRejection.label, submitted: budgetRejection.submitted, simulationRevert: budgetRejection.simulationRevert },
      expiredPermit: { label: expiryRejection.label, submitted: expiryRejection.submitted, simulationRevert: expiryRejection.simulationRevert },
      replay: { label: replay.label, simulationRevert: replay.simulationRevert, userOperationEvent: replay.userOperationEvent },
    },
    recovery: { ...recovered, replayEffect },
    canonicalBlock: { number: canonicalBlock, hash: canonical!.hash, timestamp: canonical!.timestamp },
    canonicalBalances,
    passed,
    limitations: [
      "The sponsor, bundler and beneficiary are synthetic lab wallets on the controlled local L2; no external bundler network is used.",
      "EntryPoint v0.7 does not account for the OP Stack L1 data fee in its gas charge; L1 fee accounting is part of NET-01/OPS-02 on the OP lane.",
      "The permit signature scheme is a domain-separated EIP-191 digest over the permit fields (local lab scheme), not a production paymaster policy engine.",
      "The paymaster allows exactly one target/method pair per permit and one permit use; broader policy is S21.",
    ],
    notes: [
      "A lost bundler response is recovered by querying the EntryPoint UserOperationEvent log by userOpHash and reusing the mined receipt, not by resubmitting the request.",
      "The order entry gateway marks the order id settled, so a repeated request is included as a failed user operation and moves no money.",
      "Successful and included-failure bundles are paid from the sponsor deposit; the user account's native balance delta is zero in every submitted bundle.",
    ],
  };
  writeFileSync(join(evidenceDir, "sponsored-order.json"), `${json(evidence)}\n`);
  console.log(`wrote evidence/s17/sponsored-order.json passed=${String(passed)} userOps=${String(results.length)} submitted=${String(submitted.length)}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
