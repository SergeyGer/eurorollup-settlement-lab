/**
 * Settlement pack verifier.
 *
 * Validates the manifest digests, the separate business/chain state, journal balances,
 * the null-with-reason contract for unknown chain fields and, with `--rpc`, follows the
 * pack to the chain: transaction receipt, log index, L2 block hash and the token balances
 * at the same canonical block. Prints the first mismatch and exits non-zero on tamper.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { Interface, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { hashJson } from "../packages/dealing/src/hash.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export interface PackVerificationOptions {
  readonly rpcUrl?: string;
}
export interface PackVerificationResult {
  readonly passed: boolean;
  readonly checks: number;
  readonly mismatches: string[];
  readonly checksRun: string[];
}

interface PackRecord {
  readonly [key: string]: any;
}

export async function verifySettlementPack(pack: PackRecord, options: PackVerificationOptions = {}): Promise<PackVerificationResult> {
  const schema = JSON.parse(readFileSync(join(repoRoot, "schemas/settlement-pack.schema.json"), "utf8")) as Record<string, unknown>;
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(schema);
  const mismatches: string[] = [];
  const checksRun: string[] = [];
  const check = (label: string, condition: boolean, detail: string): void => {
    checksRun.push(label);
    if (!condition) mismatches.push(`${label}: ${detail}`);
  };

  check("schema", validate(pack) === true, JSON.stringify(validate.errors));
  const order = pack["order"] as Record<string, any>;
  const business = pack["business"] as Record<string, any>;
  const chain = pack["chain"] as Record<string, any>;
  const environment = pack["environment"] as Record<string, any>;
  const manifest = pack["manifest"] as Record<string, any>;

  check("run-order", pack["runId"] === pack["orderId"] && order["orderId"] === pack["orderId"], "runId and order ids differ");
  check("generated-at", typeof pack["generatedAt"] === "string" && pack["generatedAt"].length > 0, "generatedAt missing");

  const expectedSections: Record<string, string> = {
    order: hashJson(order),
    business: hashJson(business),
    costs: hashJson(pack["costs"]),
    chain: hashJson(chain),
    environment: hashJson(environment),
  };
  for (const [name, digest] of Object.entries(expectedSections)) {
    check(`manifest-section-${name}`, manifest["sections"]?.[name] === digest, `expected ${digest} observed ${String(manifest["sections"]?.[name])}`);
  }
  const expectedPackDigest = hashJson({ order, business, costs: pack["costs"], chain, environment });
  check("manifest-pack-digest", manifest["packDigest"] === expectedPackDigest, `expected ${expectedPackDigest} observed ${String(manifest["packDigest"])}`);

  check("business-state", business["businessState"] === order["businessState"], `business state ${String(business["businessState"])} != order state ${String(order["businessState"])}`);
  check("business-chain-separated", business["chainStateField"] === order["chainState"], "the business section must track the API chain-state field separately");
  const settledStates = new Set(["FILLED", "ALLOCATED", "REDEEMED"]);
  if (settledStates.has(String(order["businessState"]))) {
    check("receipt-present", business["receipt"] !== null, "a settled order must include its receipt");
    check("receipt-order", business["receipt"]?.["orderId"] === pack["orderId"], "receipt order id mismatch");
  }

  const journalBalances = (business["journalBalances"] as Array<Record<string, any>>).slice();
  const recomputed = new Map<string, bigint>();
  for (const entry of business["journalEntries"] as Array<Record<string, any>>) {
    for (const posting of entry["postings"] as Array<Record<string, any>>) {
      const key = `${String(posting["accountKind"])}|${String(posting["accountId"])}|${String(posting["assetId"])}`;
      recomputed.set(key, (recomputed.get(key) ?? 0n) + BigInt(String(posting["amountBase"])));
    }
  }
  for (const balance of journalBalances) {
    const key = `${String(balance["accountKind"])}|${String(balance["account"])}|${String(balance["assetId"])}`;
    check(`journal-balance-${key}`, recomputed.get(key) === BigInt(String(balance["amountBase"])), `expected ${String(recomputed.get(key) ?? 0n)} observed ${String(balance["amountBase"])}`);
  }
  const perAsset = new Map<string, bigint>();
  for (const entry of business["journalEntries"] as Array<Record<string, any>>) {
    for (const posting of entry["postings"] as Array<Record<string, any>>) {
      perAsset.set(String(posting["assetId"]), (perAsset.get(String(posting["assetId"])) ?? 0n) + BigInt(String(posting["amountBase"])));
    }
  }
  for (const [assetId, sum] of perAsset) {
    check(`journal-conservation-${assetId}`, sum === 0n, `postings for ${assetId} sum to ${sum.toString()}`);
  }
  check("costs-timestamps", (pack["costs"] as Array<Record<string, any>>).every((cost) => typeof cost["asOf"] === "string" && cost["asOf"].length > 0), "every cost input must carry a timestamp");

  check("chain-policy-hash", chain["policyHash"] === environment["policyHash"], "chain policy hash differs from the environment policy hash");
  const nullReasons = new Map<string, string>((chain["unknowns"] as Array<Record<string, any>>).map((entry) => [String(entry["field"]), String(entry["reason"])]));
  const nullFields = ["orderIdBytes32", "userOpHash", "txHash", "logIndex", "l2BlockHash", "l2BlockNumber", "canonicalBlockNumber", "canonicalBlockHash", "l1BatchReference", "observedAt", "receiptStatus"] as const;
  if (chain["status"] === "NOT_ATTACHED") {
    for (const field of nullFields) check(`chain-${field}`, chain[field] === null, `NOT_ATTACHED packs must keep ${field} null`);
    for (const field of ["orderIdBytes32", "userOpHash", "txHash", "logIndex", "l2BlockHash", "l1BatchReference"]) {
      check(`chain-reason-${field}`, nullReasons.has(`chain.${field}`) && (nullReasons.get(`chain.${field}`) ?? "").length > 0, `missing null reason for chain.${field}`);
    }
    check("chain-separate-state", order["chainState"] === "NOT_SUBMITTED", `API chain state ${String(order["chainState"])} does not match NOT_ATTACHED semantics`);
  } else {
    check("chain-order-id", HEX32.test(String(chain["orderIdBytes32"])), "the onchain order id projection must be 32 bytes");
    check("chain-tx-hash", HEX32.test(String(chain["txHash"])), "txHash must be 32 bytes");
    check("chain-block-hash", HEX32.test(String(chain["l2BlockHash"])), "l2BlockHash must be 32 bytes");
    check("chain-canonical-block", Number.isInteger(chain["canonicalBlockNumber"]) && Number(chain["canonicalBlockNumber"]) >= Number(chain["l2BlockNumber"]) && HEX32.test(String(chain["canonicalBlockHash"])), "the canonical observation block must be recorded at or after the transaction block");
    check("chain-log-index", Number.isInteger(chain["logIndex"]) && Number(chain["logIndex"]) >= 0, "logIndex must be a non-negative integer");
    check("chain-receipt-status", chain["receiptStatus"] === 1, "the observed transaction receipt must be successful");
    if (chain["userOpHash"] === null) {
      check("chain-userop-reason", (nullReasons.get("chain.userOpHash") ?? "").length > 0, "a null userOpHash must carry a reason");
    } else {
      check("chain-userop-hash", HEX32.test(String(chain["userOpHash"])), "userOpHash must be 32 bytes");
    }
    if (chain["l1BatchReference"] === null) {
      check("chain-l1-reason", (nullReasons.get("chain.l1BatchReference") ?? "").length > 0, "a null L1 batch reference must carry a reason");
    }
  }

  if (options.rpcUrl !== undefined && chain["status"] === "OBSERVED") {
    const provider = new JsonRpcProvider(options.rpcUrl, undefined, { staticNetwork: true });
    const receipt = await provider.getTransactionReceipt(String(chain["txHash"]));
    check("rpc-receipt", receipt !== null && receipt.status === 1, "the transaction receipt could not be loaded");
    check("rpc-block-hash", receipt?.blockHash?.toLowerCase() === String(chain["l2BlockHash"]).toLowerCase(), `chain block ${String(receipt?.blockHash)} differs from pack ${String(chain["l2BlockHash"])}`);
    check("rpc-block-number", receipt?.blockNumber === Number(chain["l2BlockNumber"]), `chain block number ${String(receipt?.blockNumber)} differs from pack ${String(chain["l2BlockNumber"])}`);
    const canonicalBlock = await provider.getBlock(Number(chain["canonicalBlockNumber"]));
    check("rpc-canonical-block", canonicalBlock?.hash?.toLowerCase() === String(chain["canonicalBlockHash"]).toLowerCase(), `canonical block hash ${String(canonicalBlock?.hash)} differs from pack ${String(chain["canonicalBlockHash"])}`);
    const log = receipt?.logs[Number(chain["logIndex"])];
    check("rpc-log-index", log !== undefined, "no log at the recorded log index");
    if (log !== undefined) {
      check("rpc-log-order-id", log.topics[1]?.toLowerCase() === String(chain["orderIdBytes32"]).toLowerCase(), `log order id topic ${String(log.topics[1])} differs from pack ${String(chain["orderIdBytes32"])}`);
      const eventSignature = "SpotSettled(bytes32,address,address,uint256,uint256,uint256)";
      const expectedTopic = "0x" + Buffer.from(keccak256(toUtf8Bytes(eventSignature)).slice(2), "hex").toString("hex");
      check("rpc-log-event", log.topics[0]?.toLowerCase() === expectedTopic.toLowerCase(), `log event topic ${String(log.topics[0])} is not SpotSettled`);
      const contracts = chain["contracts"] as Record<string, string>;
      check("rpc-log-contract", log.address.toLowerCase() === String(contracts["settlement"]).toLowerCase(), "the log was not emitted by the recorded settlement contract");
    }
    for (const observation of chain["observations"] as Array<Record<string, any>>) {
      const contracts = chain["contracts"] as Record<string, string>;
      const tokenAddress = contracts[String(observation["assetId"])];
      if (tokenAddress === undefined) continue;
      const iface = new Interface(["function balanceOf(address) view returns (uint256)"]);
      const data = iface.encodeFunctionData("balanceOf", [String(observation["account"])]);
      const raw = await provider.call({ to: tokenAddress, data, blockTag: Number(chain["canonicalBlockNumber"]) });
      const observed = BigInt(raw);
      check(`rpc-balance-${String(observation["role"])}-${String(observation["assetId"])}`, observed === BigInt(String(observation["amountBase"])), `expected ${String(observation["amountBase"])} observed ${observed.toString()}`);
    }
  }

  return { passed: mismatches.length === 0, checks: checksRun.length, mismatches, checksRun };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const packPath = args[args.indexOf("--pack") + 1];
  const rpcIndex = args.indexOf("--rpc");
  const rpcUrl = rpcIndex === -1 ? undefined : args[rpcIndex + 1];
  if (packPath === undefined || packPath.startsWith("--")) {
    console.error("usage: verify-settlement-pack --pack <pack.json> [--rpc <url>]");
    process.exit(2);
  }
  const pack = JSON.parse(readFileSync(packPath, "utf8")) as PackRecord;
  const result = await verifySettlementPack(pack, rpcUrl === undefined ? {} : { rpcUrl });
  if (!result.passed) {
    console.error(`settlement pack verification failed (${String(result.mismatches.length)} mismatch(es))`);
    console.error(`MISMATCH: ${result.mismatches[0]!}`);
    process.exit(1);
  }
  console.log(`settlement pack verified: ${String(result.checks)} checks, run ${String(pack["runId"])}${rpcUrl === undefined ? " (offline)" : " (with chain follow)"}`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("verify-settlement-pack.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
