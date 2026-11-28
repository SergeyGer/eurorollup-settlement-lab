/**
 * S16 fixture and proof helpers.
 *
 * Builds small wallet-bound eligibility trees for the synthetic settlement accounts with
 * the pinned Noir hash circuits, then produces real UltraHonk proofs for the EVM target
 * that the onchain registry verifies. The repo fixtures stay untouched: everything runs
 * in a temporary copy of the circuits workspace.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLASS_CODES = { VERIFIED: 3, BASIC: 2, FLAGGED: 1 } as const;
export type ClassName = keyof typeof CLASS_CODES;
export const TREE_DEPTH = 3;
export const PUBLIC_INPUT_COUNT = 7;
export const GATES = {
  SPOT_ROUTER: BigInt("0x2000000000000000000000000000000000000001"),
  FUND_SUBSCRIPTION: BigInt("0x2000000000000000000000000000000000000002"),
  FUND_REDEMPTION: BigInt("0x2000000000000000000000000000000000000003"),
  SHARE_TRANSFER: BigInt("0x2000000000000000000000000000000000000004"),
} as const;
export type GateName = keyof typeof GATES;

export interface LeafSpec {
  readonly label: string;
  readonly wallet: string;
  readonly class: ClassName;
  readonly epoch: number;
  readonly expiry: number;
  readonly saltLabel: string;
}
export interface BuiltEpoch {
  readonly epoch: number;
  readonly root: string;
  readonly levels: string[][];
  readonly leaves: Array<LeafSpec & { readonly leafIndex: number; readonly leafHash: string; readonly salt: string }>;
}
export interface Witness {
  readonly wallet: string;
  readonly class: number;
  readonly epoch: number;
  readonly expiry: number;
  readonly salt: string;
  readonly path: string[];
  readonly indices: boolean[];
}
export interface ProofBundle {
  readonly proof: string;
  readonly publicInputs: string[];
  readonly localVerified: boolean;
}

const JSON_ = (value: unknown): string => JSON.stringify(value, null, 2);
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
function nargo(cwd: string): string {
  return process.env.NARGO_BIN ?? join(process.env.HOME ?? "", ".nargo", "bin", "nargo");
}
function bb(cwd: string): string {
  return process.env.BB_BIN ?? join(process.env.HOME ?? "", ".bb", "bb");
}
function fieldHash(workDir: string, packageName: "hash_leaf" | "hash_node", inputs: Record<string, string>): bigint {
  const proverToml = Object.entries(inputs)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");
  writeFileSync(join(workDir, packageName, "Prover.toml"), `${proverToml}\n`);
  const output = run(nargo(workDir), ["execute", "--package", packageName], workDir);
  const match = /Circuit output: 0x([0-9a-f]+)/i.exec(output);
  if (match === null || match[1] === undefined) throw new Error(`hash tool ${packageName} produced no output:\n${output}`);
  return BigInt(`0x${match[1]}`);
}

export function prepareWorkspace(circuitsRoot: string): { workDir: string; eligibilityJson: string; vkPath: string; vkHash: string } {
  const workDir = join(tmpdir(), `s16-eligibility-${String(process.pid)}-${String(Date.now())}`);
  cpSync(circuitsRoot, workDir, { recursive: true });
  run(nargo(workDir), ["compile", "--workspace"], workDir);
  const eligibilityJson = join(workDir, "target", "eligibility.json");
  const vkDir = join(workDir, "vk-evm");
  run(bb(workDir), ["write_vk", "-b", eligibilityJson, "-o", vkDir, "-t", "evm"], workDir);
  const vkPath = join(vkDir, "vk");
  const vkHash = readFileSync(join(vkDir, "vk_hash")).toString("hex");
  return { workDir, eligibilityJson, vkPath, vkHash };
}

function saltFor(label: string): string {
  const digest = createHash("sha256").update(`s16-salt:${label}`).digest("hex");
  return (BigInt(`0x${digest}`) % BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617")).toString();
}

export function buildEpoch(workDir: string, epoch: number, leaves: LeafSpec[]): BuiltEpoch {
  const leafHashes = leaves.map((leaf) =>
    fieldHash(workDir, "hash_leaf", {
      wallet: BigInt(leaf.wallet).toString(),
      class: String(CLASS_CODES[leaf.class]),
      epoch: String(epoch),
      expiry: String(leaf.expiry),
      salt: saltFor(leaf.saltLabel),
    }),
  );
  const levels: bigint[][] = [leafHashes];
  let level = leafHashes;
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(fieldHash(workDir, "hash_node", { left: level[index]!.toString(), right: level[index + 1]!.toString() }));
    }
    levels.push(next);
    level = next;
  }
  if (levels.length !== TREE_DEPTH + 1) throw new Error(`expected tree depth ${String(TREE_DEPTH)}, got ${String(levels.length - 1)}`);
  return {
    epoch,
    root: level[0]!.toString(),
    levels: levels.map((row) => row.map((value) => value.toString())),
    leaves: leaves.map((leaf, index) => ({
      ...leaf,
      leafIndex: index,
      leafHash: leafHashes[index]!.toString(),
      salt: saltFor(leaf.saltLabel),
    })),
  };
}

export function witnessFor(epoch: BuiltEpoch, leafIndex: number): Witness {
  const leaf = epoch.leaves[leafIndex]!;
  const path: string[] = [];
  const indices: boolean[] = [];
  let index = leafIndex;
  for (let depth = 0; depth < TREE_DEPTH; depth += 1) {
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    path.push(epoch.levels[depth]![sibling]!);
    indices.push(index % 2 === 1);
    index = Math.floor(index / 2);
  }
  return { wallet: leaf.wallet, class: CLASS_CODES[leaf.class], epoch: epoch.epoch, expiry: leaf.expiry, salt: leaf.salt, path, indices };
}

export function proveEligibility(params: {
  workDir: string;
  eligibilityJson: string;
  vkPath: string;
  witness: Witness;
  root: string;
  chainId: number;
  gate: GateName;
}): ProofBundle {
  const gate = GATES[params.gate];
  const proverToml = [
    `wallet = "${BigInt(params.witness.wallet).toString()}"`,
    `root = "${params.root}"`,
    `chain_id = "${String(params.chainId)}"`,
    `gate = "${gate.toString()}"`,
    `class = "${String(params.witness.class)}"`,
    `epoch = "${String(params.witness.epoch)}"`,
    `expiry = "${String(params.witness.expiry)}"`,
    `salt = "${params.witness.salt}"`,
    `path = [${params.witness.path.map((value) => `"${value}"`).join(", ")}]`,
    `indices = [${params.witness.indices.map((value) => (value ? "true" : "false")).join(", ")}]`,
  ].join("\n");
  writeFileSync(join(params.workDir, "eligibility", "Prover.toml"), `${proverToml}\n`);
  run(nargo(params.workDir), ["execute", "--package", "eligibility"], params.workDir);
  const witnessPath = join(params.workDir, "target", "eligibility.gz");
  const proofDir = join(params.workDir, `proof-${params.gate}-${String(params.witness.epoch)}-${params.witness.wallet.slice(2, 8)}`);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  run(bb(params.workDir), ["prove", "-b", params.eligibilityJson, "-w", witnessPath, "-o", proofDir, "-k", params.vkPath, "-t", "evm"], params.workDir);
  // Local verification with the same EVM-target vk catches a broken witness before the
  // onchain step, where a failure would be much harder to attribute.
  let localVerified = false;
  try {
    run(bb(params.workDir), ["verify", "-k", params.vkPath, "-p", join(proofDir, "proof"), "-i", join(proofDir, "public_inputs"), "-t", "evm"], params.workDir);
    localVerified = true;
  } catch {
    localVerified = false;
  }
  const proof = readFileSync(join(proofDir, "proof")).toString("hex");
  const publicInputsBytes = readFileSync(join(proofDir, "public_inputs"));
  const publicInputs: string[] = [];
  for (let offset = 0; offset < publicInputsBytes.length; offset += 32) {
    publicInputs.push(`0x${publicInputsBytes.subarray(offset, offset + 32).toString("hex")}`);
  }
  return { proof: `0x${proof}`, publicInputs, localVerified };
}

export function writeFixturesEvidence(path: string, fixture: { chainId: number; epochs: BuiltEpoch[]; circuits: Record<string, unknown> }): string {
  const payload = {
    fixtureId: "S16-ONCHAIN-ELIGIBILITY",
    fixtureVersion: "1.0.0",
    description: "Deterministic S16 wallet-bound eligibility trees over the synthetic settlement accounts.",
    treeDepth: TREE_DEPTH,
    chainId: fixture.chainId,
    circuits: fixture.circuits,
    epochs: fixture.epochs,
  };
  const text = `${JSON_(payload)}\n`;
  writeFileSync(path, text);
  return sha256(text);
}
