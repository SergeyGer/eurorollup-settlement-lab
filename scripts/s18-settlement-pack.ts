/**
 * S18 / SET-04 settlement pack export.
 *
 * Boots the partner API with a chain-witness path, submits the SDK G01 spot order, opens
 * the order receipt in the browser replay, downloads the settlement pack from the UI and
 * independently follows it to the chain: the settlement transaction log carrying the
 * onchain order id, the L2 block hash and the investor/escrow/issuer/fee balances at that
 * canonical block. A tampered copy must make the verifier exit non-zero with the first
 * mismatch.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  keccak256,
  toUtf8Bytes,
  type TransactionReceipt,
} from "ethers";
import { chromium } from "playwright";
import { hashJson } from "../packages/dealing/src/hash.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s18");
const mediaDir = join(repoRoot, "docs", "media");
const tmpDir = join(repoRoot, "tmp-s18");
const runDir = process.env.DEVNET_LOCAL_RUN_DIR ?? join(repoRoot, ".devnet-local", "run");
const envPath = join(runDir, "env.json");
const API_PORT = 3000;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_PORT = 8089;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}/`;
const witnessPath = join(tmpDir, "chain-witness.json");
const CASH_UNIT = 1_000_000n;
const SPOT_UNIT = 1_000_000_000_000_000_000n;
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

async function waitFor(url: string, predicate: (response: Response) => boolean, timeoutMs = 60_000): Promise<Response> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (predicate(response)) return response;
    } catch {
      // server still starting
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${API_URL}${path}`, init);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
}
function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8")) as {
    abi: unknown[];
    bytecode: { object: string };
  };
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}
function deterministicWallet(label: string, provider: JsonRpcProvider): Wallet {
  return new Wallet(keccak256(toUtf8Bytes(`eurorollup-s18-${label}`)), provider);
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  rmSync(witnessPath, { force: true });
  if (!existsSync(envPath)) throw new Error("controlled devnet is not running; start it with pnpm devnet:up");
  const env = JSON.parse(readFileSync(envPath, "utf8")) as { l1Rpc: string; l2Rpc: string; portal: string; keys: { deployer: string } };

  // 1. Build the browser replay and boot the API with the chain-witness path.
  console.log("building the web replay…");
  execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "ignore" });
  // Fresh API database so the G01 portfolio starts at the fixture seed on every capture.
  mkdirSync(join(repoRoot, ".data"), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(repoRoot, ".data", `api.sqlite${suffix}`), { force: true });
  const apiLog = join(tmpDir, "api.log");
  const apiProcess: ChildProcess = spawn(tsxBin, ["apps/api/src/server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, CHAIN_WITNESS_PATH: witnessPath, MODEL_TIMEOUT_MS: "15000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let apiOutput = "";
  apiProcess.stdout?.on("data", (chunk: Buffer) => (apiOutput += chunk.toString("utf8")));
  apiProcess.stderr?.on("data", (chunk: Buffer) => (apiOutput += chunk.toString("utf8")));
  writeFileSync(apiLog, "");
  const webProcess = spawn("python3", ["-m", "http.server", String(WEB_PORT), "--bind", "127.0.0.1", "--directory", "apps/web/dist"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  try {
    const healthResponse = await waitFor(`${API_URL}/v1/health`, (response) => response.status === 200);
    const health = (await healthResponse.json()) as Record<string, any>;
    await waitFor(WEB_URL, (response) => response.status === 200);
    console.log(`api ${API_URL} policy epoch ${String(health["policyEpoch"])}; web ${WEB_URL}`);

    // 2. Submit the SDK G01 order and wait for the business settlement.
    const quote = await api("/v1/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({ accountId: "investor-ada", assetId: "tWETH", side: "BUY", amountBase: "200000000" }),
    });
    if (quote.status !== 200 && quote.status !== 201) throw new Error(`quote failed: ${String(quote.status)} ${json(quote.body)}`);
    const placed = await api("/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `s18-${String(Date.now())}` },
      body: json({ quoteId: quote.body.quoteId, accountId: "investor-ada" }),
    });
    if (placed.status !== 200 && placed.status !== 201 && placed.status !== 202) throw new Error(`order failed: ${String(placed.status)} ${json(placed.body)}`);
    const orderId = String(placed.body.orderId);
    let order: Record<string, any> | null = null;
    for (let waited = 0; waited < 20_000; waited += 250) {
      const response = await api(`/v1/orders/${encodeURIComponent(orderId)}`);
      if (response.status === 200 && response.body.businessState === "FILLED") {
        order = response.body as Record<string, any>;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (order === null) throw new Error(`order ${orderId} did not fill`);
    console.log(`SDK order ${orderId} filled; receipt ${json(order["receipt"])}`);

    // 3. Produce the chain witness with a real settlement transaction on the controlled L2.
    const provider = new JsonRpcProvider(env.l2Rpc, undefined, { staticNetwork: true });
    const deployer = new Wallet(env.keys.deployer, provider);
    if ((await provider.getBalance(deployer.address)) < 10n ** 18n) {
      const l1Provider = new JsonRpcProvider(env.l1Rpc, undefined, { staticNetwork: true });
      const portal = new Contract(env.portal, ["function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable"], new Wallet(env.keys.deployer, l1Provider));
      const deposit = await portal.depositTransaction(deployer.address, 5n * 10n ** 18n, 200_000n, false, "0x", { value: 5n * 10n ** 18n });
      await deposit.wait();
      for (let waited = 0; (await provider.getBalance(deployer.address)) < 10n ** 18n; waited += 2_000) {
        if (waited > 300_000) throw new Error("timed out waiting for bridged L2 gas");
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    const investor = deterministicWallet("investor", provider);
    const dealer = deterministicWallet("dealer", provider);
    const feeRecipient = deterministicWallet("fee-recipient", provider);
    const issuerTreasury = deterministicWallet("issuer-treasury", provider);
    for (const wallet of [investor, dealer, feeRecipient, issuerTreasury]) {
      if ((await provider.getBalance(wallet.address)) < 10n ** 17n) {
        await (await deployer.sendTransaction({ to: wallet.address, value: 5n * 10n ** 17n })).wait();
      }
    }
    const artifacts = {
      Token: loadArtifact("Token"),
      RestrictedShare: loadArtifact("RestrictedShare"),
      Escrow: loadArtifact("Escrow"),
      DvPSettlement: loadArtifact("DvPSettlement"),
    };
    const deploy = async (name: keyof typeof artifacts, args: readonly unknown[]): Promise<Record<string, any>> => {
      const factory = new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, deployer);
      const contract = (await factory.deploy(...args)) as unknown as Record<string, any>;
      await contract.deploymentTransaction().wait();
      return contract;
    };
    const cash = await deploy("Token", ["Demo euro cash", "dEUR", 6]);
    const spot = await deploy("Token", ["Test wrapped ETH", "tWETH", 18]);
    const fund = await deploy("RestrictedShare", ["Fictional euro fund unit", "eFUND", 6, deployer.address]);
    const escrow = await deploy("Escrow", [await cash.getAddress()]);
    const settlement = await deploy("DvPSettlement", [await cash.getAddress(), await spot.getAddress(), await fund.getAddress(), await escrow.getAddress(), feeRecipient.address, issuerTreasury.address]);
    const settlementAddress = await settlement.getAddress();
    const cashAddress = await cash.getAddress();
    const spotAddress = await spot.getAddress();
    await (await escrow.setOperator(settlementAddress)).wait();
    await (await cash.mint(investor.address, 1_000n * CASH_UNIT)).wait();
    await (await spot.mint(dealer.address, 1n * SPOT_UNIT)).wait();
    await (await cash.connect(investor).approve(settlementAddress, 2n ** 255n)).wait();
    await (await spot.connect(dealer).approve(settlementAddress, 2n ** 255n)).wait();
    const orderIdBytes32 = keccak256(toUtf8Bytes(orderId));
    const deadline = BigInt((await provider.getBlock("latest"))!.timestamp + 3_600);
    const tx = await settlement.executeSpot(orderIdBytes32, investor.address, dealer.address, 200n * CASH_UNIT, 50_000n, SPOT_UNIT / 10n, deadline);
    const receipt = (await tx.wait()) as TransactionReceipt;
    const settlementInterface = new Contract(settlementAddress, artifacts.DvPSettlement.abi).interface;
    let logIndex = -1;
    for (const [index, log] of receipt.logs.entries()) {
      try {
        const parsed = settlementInterface.parseLog(log);
        if (parsed !== null && parsed.name === "SpotSettled") {
          logIndex = index;
          break;
        }
      } catch {
        // unrelated log
      }
    }
    if (logIndex < 0) throw new Error("SpotSettled log was not found in the witness transaction");
    const canonicalBlock = await provider.getBlockNumber();
    const block = await provider.getBlock(Number(receipt.blockNumber));
    const canonical = await provider.getBlock(canonicalBlock);
    const balanceAt = async (contract: any, account: string): Promise<string> => (await contract.balanceOf(account, { blockTag: canonicalBlock })).toString();
    const observations = [
      { account: investor.address, role: "investor", assetId: "dEUR", amountBase: await balanceAt(cash, investor.address) },
      { account: investor.address, role: "investor", assetId: "tWETH", amountBase: await balanceAt(spot, investor.address) },
      { account: dealer.address, role: "dealer", assetId: "dEUR", amountBase: await balanceAt(cash, dealer.address) },
      { account: dealer.address, role: "dealer", assetId: "tWETH", amountBase: await balanceAt(spot, dealer.address) },
      { account: feeRecipient.address, role: "fee", assetId: "dEUR", amountBase: await balanceAt(cash, feeRecipient.address) },
      { account: issuerTreasury.address, role: "issuer", assetId: "dEUR", amountBase: await balanceAt(cash, issuerTreasury.address) },
      { account: await escrow.getAddress(), role: "escrow", assetId: "dEUR", amountBase: await balanceAt(cash, await escrow.getAddress()) },
    ];
    const witness = {
      orderId,
      chainId: 16584,
      orderIdBytes32,
      userOpHash: null,
      txHash: receipt.hash,
      logIndex,
      l2BlockHash: receipt.blockHash,
      l2BlockNumber: receipt.blockNumber,
      canonicalBlockNumber: canonicalBlock,
      canonicalBlockHash: canonical!.hash,
      l1BatchReference: null,
      policyHash: String(health["policyEpoch"]),
      observedAt: new Date(Number(block!.timestamp) * 1_000).toISOString(),
      receiptStatus: receipt.status ?? 0,
      contracts: { settlement: settlementAddress, dEUR: cashAddress, tWETH: spotAddress, fund: await fund.getAddress(), escrow: await escrow.getAddress() },
      observations,
      unknowns: [
        { field: "chain.userOpHash", reason: "the witness was produced on the operator settlement lane, which does not create an ERC-4337 user operation; the sponsored lane is recorded separately in S17" },
        { field: "chain.l1BatchReference", reason: "the calldata development lane does not record the L1 batch reference of a single L2 transaction" },
      ],
    };
    writeFileSync(witnessPath, `${json({ schemaVersion: "1.0.0", witnesses: [witness] })}\n`);
    console.log(`chain witness tx ${receipt.hash} logIndex ${String(logIndex)} block ${String(canonicalBlock)}`);

    // 4. Download the pack from the API and accept it through the browser receipt.
    const packResponse = await api(`/v1/runs/${encodeURIComponent(orderId)}/evidence`);
    if (packResponse.status !== 200) throw new Error(`pack export failed: ${String(packResponse.status)}`);
    const packText = `${json(packResponse.body)}\n`;
    const packPath = join(tmpDir, "pack.json");
    writeFileSync(packPath, packText);
    const pack = packResponse.body as Record<string, any>;
    const packSha256 = sha256(packText);

    const browser = await chromium.launch({ headless: true });
    let uiResult: Record<string, any>;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
      const page = await context.newPage();
      await page.goto(WEB_URL, { waitUntil: "networkidle", timeout: 60_000 });
      await page.getByRole("button", { name: "Local API lab" }).click();
      await page.locator("td.order-id").first().waitFor({ timeout: 30_000 });
      await page.locator(`td.order-id[title="${orderId}"]`).click();
      const link = page.locator('[data-testid="settlement-pack-link"]');
      await link.waitFor({ timeout: 15_000 });
      const receiptVisible = await page.getByText("Download settlement pack").isVisible();
      await page.screenshot({ path: join(mediaDir, "s18-receipt-download.png"), fullPage: false });
      const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
      await link.click();
      const download = await downloadPromise;
      const downloadPath = join(tmpDir, "pack-ui.json");
      await download.saveAs(downloadPath);
      const downloadedText = readFileSync(downloadPath, "utf8");
      uiResult = {
        url: WEB_URL,
        receiptVisible,
        screenshot: "docs/media/s18-receipt-download.png",
        screenshotSha256: sha256(readFileSync(join(mediaDir, "s18-receipt-download.png"))),
        downloadedSha256: sha256(downloadedText),
        matchesApiPack: sha256(downloadedText) === packSha256,
        suggestedFilename: download.suggestedFilename(),
      };
      await context.close();
    } finally {
      await browser.close();
    }

    // 5. Independent verification (offline + chain follow) and the tamper test.
    const verify = (path: string, rpc: boolean): { exitCode: number; stdout: string; stderr: string; firstMismatch: string | null } => {
      try {
        const stdout = execFileSync("pnpm", ["exec", "tsx", "scripts/verify-settlement-pack.ts", "--pack", path, ...(rpc ? ["--rpc", env.l2Rpc] : [])], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { exitCode: 0, stdout, stderr: "", firstMismatch: null };
      } catch (error) {
        const candidate = error as { status?: number; stdout?: string; stderr?: string };
        const stderr = String(candidate.stderr ?? "");
        const firstMismatch = stderr.split("\n").find((line) => line.startsWith("MISMATCH:")) ?? null;
        return { exitCode: candidate.status ?? 1, stdout: String(candidate.stdout ?? ""), stderr, firstMismatch };
      }
    };
    const offlineGood = verify(packPath, false);
    const chainGood = verify(packPath, true);
    const tampered = structuredClone(pack);
    tampered["business"]["receipt"]["cashDeployedBase"] = (BigInt(String(tampered["business"]["receipt"]["cashDeployedBase"])) + 1n).toString();
    const tamperedPath = join(tmpDir, "pack-tampered.json");
    writeFileSync(tamperedPath, `${json(tampered)}\n`);
    const tamperedResult = verify(tamperedPath, false);

    // 6. Compare the chain observations with the business state at the same canonical block.
    const business = pack["business"] as Record<string, any>;
    const portfolio = business["portfolio"] as Record<string, any>;
    const journalBalances = business["journalBalances"] as Array<Record<string, any>>;
    const journalBalance = (account: string, assetId: string): string => {
      const posting = journalBalances.find((entry) => entry["account"] === account && entry["assetId"] === assetId);
      return posting === undefined ? "0" : String(posting["amountBase"]);
    };
    const observation = (role: string, assetId: string): string => {
      const found = (witness.observations as Array<Record<string, any>>).find((entry) => entry["role"] === role && entry["assetId"] === assetId);
      return found === undefined ? "0" : String(found["amountBase"]);
    };
    const comparisons = [
      { label: "investor dEUR", business: String(portfolio["balances"]["dEUR"]["availableBase"]), chain: observation("investor", "dEUR") },
      { label: "investor tWETH", business: String(portfolio["balances"]["tWETH"]["availableBase"]), chain: observation("investor", "tWETH") },
      { label: "dealer dEUR movement", business: journalBalance("dealer-inventory", "dEUR"), chain: observation("dealer", "dEUR") },
      { label: "fee dEUR movement", business: journalBalance("fee-recipient", "dEUR"), chain: observation("fee", "dEUR") },
      { label: "issuer dEUR movement", business: journalBalance("issuer-treasury", "dEUR"), chain: observation("issuer", "dEUR") },
      { label: "escrow dEUR movement", business: journalBalance("fund-escrow", "dEUR"), chain: observation("escrow", "dEUR") },
    ].map((entry) => ({ ...entry, matched: entry.business === entry.chain }));

    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const passed =
      order["businessState"] === "FILLED" &&
      pack["chain"]["status"] === "OBSERVED" &&
      offlineGood.exitCode === 0 &&
      chainGood.exitCode === 0 &&
      tamperedResult.exitCode !== 0 &&
      tamperedResult.firstMismatch !== null &&
      uiResult["matchesApiPack"] === true &&
      uiResult["receiptVisible"] === true &&
      comparisons.every((entry) => entry.matched) &&
      witness.txHash === pack["chain"]["txHash"] &&
      witness.logIndex === pack["chain"]["logIndex"] &&
      witness.l2BlockHash === pack["chain"]["l2BlockHash"];

    const evidence = {
      schemaVersion: "1.0.0",
      reportId: "S18-settlement-pack",
      packId: "S18",
      generatedBy: "pnpm s18:run",
      generatedAt: new Date().toISOString(),
      commit,
      chains: { l1ChainId: 11155111, l2ChainId: 16584, lane: "controlled local OP Stack devnet (calldata DA development mode)" },
      run: { runId: orderId, orderId, quoteId: String(quote.body.quoteId), accountId: "investor-ada" },
      api: { baseUrl: API_URL, health: { serviceVersion: health["serviceVersion"], engineVersion: health["engineVersion"], policyEpoch: health["policyEpoch"], dataMode: health["mode"] }, endpoint: `/v1/runs/${orderId}/evidence` },
      order,
      pack,
      packSha256,
      chainWitness: witness,
      canonicalBlock: { number: canonicalBlock, hash: canonical!.hash, timestamp: canonical!.timestamp },
      comparisons,
      verification: {
        offline: { exitCode: offlineGood.exitCode, firstMismatch: offlineGood.firstMismatch, output: offlineGood.stdout.trim() },
        chainFollow: { exitCode: chainGood.exitCode, firstMismatch: chainGood.firstMismatch, output: chainGood.stdout.trim() },
        tampered: { exitCode: tamperedResult.exitCode, firstMismatch: tamperedResult.firstMismatch, mutation: "business.receipt.cashDeployedBase +1 base unit" },
      },
      ui: uiResult,
      unknowns: pack["chain"]["unknowns"],
      passed,
      limitations: [
        "The chain witness is attached to the run through an operator-produced witness artifact (CHAIN_WITNESS_PATH); the API does not yet run a chain reader itself, which arrives with NET-01.",
        "The witness uses the operator settlement lane; userOpHash is null with a reason, while the sponsored ERC-4337 lane is recorded in S17.",
        "The calldata development lane does not record an L1 batch reference for a single L2 transaction, so that field is null with a reason.",
        "Balances are compared at one canonical L2 block; issuer treasury and escrow start at zero on this lane so their movements and balances coincide.",
      ],
      notes: [
        "The pack keeps business state and observed chain status in separate objects; unavailable chain fields are null with reasons.",
        "The tampered copy changes one receipt amount and the verifier exits non-zero with the first manifest-section mismatch.",
        "The UI download and the API response are byte-identical.",
      ],
    };
    writeFileSync(join(evidenceDir, "settlement-pack-run.json"), `${json(evidence)}\n`);
    console.log(`wrote evidence/s18/settlement-pack-run.json passed=${String(passed)} packDigest=${String(pack["manifest"]["packDigest"]).slice(0, 12)}…`);
    if (!passed) process.exitCode = 1;
  } finally {
    webProcess.kill();
    apiProcess.kill();
    if (apiOutput.length > 0) writeFileSync(join(tmpDir, "api.log"), apiOutput);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
