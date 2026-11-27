/**
 * Compiles the eligibility circuit with the pinned Noir toolchain and copies the
 * artifact, verification key and verifier metadata into the runtime package.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const circuitsRoot = join(repoRoot, "circuits");
const artifactsRoot = join(repoRoot, "packages/eligibility/artifacts");
const nargoBin = process.env.NARGO_BIN ?? join(process.env.HOME ?? "", ".nargo", "bin", "nargo");
const bbBin = process.env.BB_BIN ?? join(process.env.HOME ?? "", ".bb", "bb");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

mkdirSync(artifactsRoot, { recursive: true });
console.log("compiling Noir workspace…");
execFileSync(nargoBin, ["compile", "--workspace"], { cwd: circuitsRoot, stdio: "inherit" });
console.log("generating verification key…");
execFileSync(bbBin, ["write_vk", "-b", "target/eligibility.json", "-o", "target/vk"], {
  cwd: circuitsRoot,
  stdio: "inherit",
});

const circuitPath = join(circuitsRoot, "target/eligibility.json");
const vkPath = join(circuitsRoot, "target/vk/vk");
const vkHashPath = join(circuitsRoot, "target/vk/vk_hash");
const circuitBytes = readFileSync(circuitPath);
const vkBytes = readFileSync(vkPath);
const vkHashBytes = readFileSync(vkHashPath);

copyFileSync(circuitPath, join(artifactsRoot, "eligibility.json"));
copyFileSync(vkPath, join(artifactsRoot, "vk"));
copyFileSync(vkHashPath, join(artifactsRoot, "vk_hash"));

const metadata = {
  circuitId: "eligibility",
  circuitVersion: "1.0.0",
  noirVersion: execFileSync(nargoBin, ["--version"], { encoding: "utf8" }).split("\n")[0]?.trim(),
  bbVersion: execFileSync(bbBin, ["--version"], { encoding: "utf8" }).trim(),
  treeDepth: 3,
  hashFunction: "pedersen_bn254",
  publicInputs: ["wallet", "root", "chain_id", "gate", "class", "epoch", "expiry"],
  proofSystem: "ultra_honk",
  circuitSha256: sha256Hex(circuitBytes),
  vkSha256: sha256Hex(vkBytes),
  vkHash: vkHashBytes.toString("hex"),
  circuitBytes: circuitBytes.byteLength,
  vkBytes: vkBytes.byteLength,
  generatedBy: "pnpm eligibility:build",
};
writeFileSync(join(artifactsRoot, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`wrote ${artifactsRoot}/eligibility.json, vk, vk_hash, metadata.json`);
console.log(`vk sha256: ${metadata.vkSha256}`);
