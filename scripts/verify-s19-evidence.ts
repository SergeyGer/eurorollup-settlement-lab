/**
 * Offline verification of the S19 / NET-01 consensus-backed lane evidence.
 *
 * Checks pinned manifests, genesis/config digests, the blob transaction -> beacon slot ->
 * sidecar commitment chain, L1 finality, the sequencer/deriving-verifier block hash match,
 * the unsafe/safe/finalized head samples and the explicitly accelerated canonical portal
 * withdrawal reference.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}
function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/s19-net01-lane.schema.json"));
  const evidence = readJson("evidence/s19/net01-lane.json");
  check(validate(evidence) === true, `schema validation: ${JSON.stringify(validate.errors)}`);
  check(evidence["chains"]["l2ChainId"] === 16584, "the evidence is bound to the expected L2 chain id");
  check(String(evidence["laneId"]).startsWith("NET01-"), "a separate run identifier is recorded");

  const manifests = evidence["manifests"] as Array<Record<string, any>>;
  check(manifests.filter((entry) => entry["missing"] !== true).length >= 6, "at least six lane components have pinned image records");
  for (const manifest of manifests.filter((entry) => entry["missing"] !== true)) {
    check(typeof manifest["image"] === "string" && manifest["image"].length > 0, `${String(manifest["service"])} image is recorded`);
    check(typeof manifest["imageId"] === "string" && manifest["imageId"].length > 0, `${String(manifest["service"])} image id is recorded`);
  }
  const configs = evidence["configs"] as Record<string, any>;
  check(configs["genesisConfig"]["chainId"] === 16584, "the rollup config chain id is recorded");
  check(/^[0-9a-f]{64}$/.test(String(configs["genesisConfig"]["configDigest"])), "the rollup config digest is recorded");
  check(typeof configs["genesisConfig"]["batchInbox"] === "string" && String(configs["genesisConfig"]["batchInbox"]).startsWith("0x"), "the batch inbox is recorded");
  check(typeof configs["genesisConfig"]["portal"] === "string" && String(configs["genesisConfig"]["portal"]).startsWith("0x"), "the portal is recorded");
  const artifacts = configs["fileArtifacts"] as Record<string, string>;
  check(Object.keys(artifacts).some((key) => key.includes("rollup-16584.json")), "the rollup config artifact digest is listed");
  check(Object.keys(artifacts).some((key) => key.includes("genesis-16584.json")), "the L2 genesis artifact digest is listed");
  check(Object.keys(artifacts).some((key) => key.includes("config.yaml")), "the L1 consensus config artifact digest is listed");
  check(HEX32.test(String(configs["l1Genesis"]["hash"])), "the L1 genesis block hash is recorded");
  check(/^0x[0-9a-fA-F]{64}$/.test(String(configs["l2Genesis"]["hash"])), "the L2 genesis block hash is recorded");

  const health = evidence["health"] as Array<Record<string, any>>;
  check(health.length >= 4, "the health probes are recorded");
  check(evidence["subChecks"]["laneHealthy"] === true, "the lane health checks passed");

  const before = (evidence["heads"]["before"] as Record<string, any>)["l2"];
  const after = (evidence["heads"]["after"] as Record<string, any>)["l2"];
  check(number(after["unsafe"]["number"]) > number(before["unsafe"]["number"]), "the L2 unsafe head advanced during the capture");
  check(number(after["safe"]["number"]) > number(before["safe"]["number"]), "the L2 safe head advanced during the capture");
  check(HEX32.test(String(after["safe"]["hash"])), "the final L2 safe head hash is recorded");
  check(HEX32.test(String(after["finalized"]["hash"])), "the final L2 finalized head sample is recorded");

  const blob = evidence["blob"] as Record<string, any>;
  check(HEX32.test(String(blob["txHash"])), "the blob transaction hash is recorded");
  check(Array.isArray(blob["versionedHashes"]) && blob["versionedHashes"].length > 0, "the blob versioned hash is recorded");
  check(blob["receiptStatus"] === 1, "the blob transaction receipt succeeded");
  check(String(blob["blobGasUsed"]) !== "0x0", "the blob gas usage is non-zero");
  check(number(blob["blockNumber"]) > 0, "the L1 block containing the blob transaction is recorded");
  check(blob["beaconBlock"] !== null, "the beacon slot for the blob block is recorded");
  if (blob["beaconBlock"] !== null) {
    check(number(blob["beaconBlock"]["slot"]) > 0, "the beacon slot number is recorded");
    check(String(blob["beaconBlock"]["executionBlockHash"]).toLowerCase() === String(blob["blockHash"]).toLowerCase(), "the beacon block payload hash matches the L1 blob block hash");
    check(HEX32.test(String(blob["beaconBlock"]["root"])), "the beacon block root is recorded");
  }
  const sidecars = blob["sidecarCommitments"] as Array<Record<string, any>>;
  check(sidecars.length > 0 && sidecars.some((sidecar) => sidecar["matched"] === true), "a blob sidecar commitment matches the L1 versioned hash");
  const matched = sidecars.find((sidecar) => sidecar["matched"] === true);
  check(matched !== undefined && (blob["versionedHashes"] as string[]).some((hash) => hash.toLowerCase() === String(matched["versionedHash"]).toLowerCase()), "the sidecar versioned hash is the transaction versioned hash");
  check(/^0x[0-9a-fA-F]{96}$/.test(String(matched?.["kzg_commitment"] ?? "")), "the KZG commitment is recorded");

  const derivation = evidence["derivation"] as Record<string, any>;
  check(derivation["activityMatchesDerivation"] === true, "the activity is derived from L1");
  const verifier = derivation["derivingVerifier"] as Record<string, any>;
  check(verifier["match"] === true && verifier["passed"] === true, "the independent deriving verifier matches the sequencer block hash");
  check(String(verifier["sequencerBlockHash"]).toLowerCase() === String(verifier["verifierBlockHash"]).toLowerCase(), "the sequencer and verifier block hashes are identical");
  check(number(verifier["activityBlock"]) === number(evidence["activity"]["lastBlock"]), "the verifier comparison uses the activity block");
  check(HEX32.test(String(verifier["configDigests"]["genesis"])) || /^[0-9a-f]{64}$/.test(String(verifier["configDigests"]["genesis"])), "the verifier genesis digest is recorded");
  check(/^[0-9a-f]{64}$/.test(String(verifier["configDigests"]["rollup"])), "the verifier rollup config digest is recorded");

  const finality = evidence["finality"] as Record<string, any>;
  check(number(finality["l1Finalized"]["number"]) >= number(blob["blockNumber"]), "L1 finality covers the blob transaction block");
  check(number(finality["beaconFinality"]["finalized"]["epoch"]) > 0, "the beacon chain recorded a finalized checkpoint");
  check(HEX32.test(String(finality["l1Finalized"]["hash"])), "the L1 finalized block hash is recorded");

  const withdrawal = evidence["withdrawal"] as Record<string, any>;
  check(withdrawal["repeatedOnAcceleratedLane"] === true, "the canonical portal withdrawal is replayed with a labelled acceleration");
  check((withdrawal["timeAcceleration"] as unknown[]).length >= 1, "the clock acceleration is recorded explicitly");
  check(withdrawal["finalization"]["status"] === 1, "the recorded portal finalization succeeded");
  check(String(withdrawal["finalization"]["recipientDeltaWei"]) === "100000000000000000", "the recorded withdrawal relayed exactly 0.1 ETH");
  check(withdrawal["proving"]["txHash"].startsWith("0x") && withdrawal["withdrawal"]["l2Tx"].startsWith("0x"), "the proving and initiation transactions are recorded");

  check(evidence["subChecks"]["blobTransactionObserved"] === true, "the blob transaction sub-check passed");
  check(evidence["subChecks"]["sidecarMatched"] === true, "the sidecar sub-check passed");
  check(evidence["subChecks"]["activityDerivedFromL1"] === true, "the derivation sub-check passed");
  check(evidence["subChecks"]["l1FinalityCoveredBlob"] === true, "the finality sub-check passed");
  check(evidence["passed"] === true, "the NET-01 evidence records a pass");
  check((evidence["limitations"] as unknown[]).length >= 3, "limitations are recorded");

  if (failures.length > 0) {
    console.error("S19 NET-01 evidence verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `NET-01 verified: blob ${String(blob["txHash"]).slice(0, 10)}… on L1 block ${String(blob["blockNumber"])}, beacon slot ${String(blob["beaconBlock"]["slot"])}, ` +
      `${String(sidecars.filter((sidecar) => sidecar["matched"] === true).length)} matched sidecar(s), deriving verifier matches activity block ${String(verifier["activityBlock"])}, ` +
      `L1 finalized ${String(finality["l1Finalized"]["number"])}, withdrawal accel ${String((withdrawal["timeAcceleration"] as Array<Record<string, any>>).map((entry) => entry["requestedSeconds"]).join("+"))}s`,
  );
}

main();
