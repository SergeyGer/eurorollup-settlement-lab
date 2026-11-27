/**
 * Eligibility prover.
 *
 * Generates real UltraHonk proofs for the committed eligibility circuit. The same
 * module is used by the API, the CLI evidence runner and the browser view; the
 * caller supplies synthetic witness data from the bundled fixtures.
 */
import { Barretenberg, UltraHonkBackend } from "@aztec-foundation/bb.js";
import { Noir } from "@noir-lang/noir_js";
import type { CompiledCircuit } from "@noir-lang/types";
import circuitJson from "../artifacts/eligibility.json";
import metadataJson from "../artifacts/metadata.json";
import { epochByNumber, gateById, personaById, witnessFor } from "./fixtures.js";
import { classRank } from "./policy.js";
import type {
  EligibilityClass,
  EligibilityProof,
  EligibilityPublicInputs,
  GateId,
} from "./types.js";

export const ELIGIBILITY_CIRCUIT_VERSION = "1.0.0";

export interface CircuitMetadata {
  readonly circuitId: string;
  readonly circuitVersion: string;
  readonly noirVersion: string;
  readonly bbVersion: string;
  readonly treeDepth: number;
  readonly hashFunction: string;
  readonly publicInputs: readonly string[];
  readonly proofSystem: string;
  readonly circuitSha256: string;
  readonly vkSha256: string;
  readonly vkHash: string;
  readonly circuitBytes: number;
  readonly vkBytes: number;
  readonly generatedBy: string;
}

export const circuitMetadata = metadataJson as unknown as CircuitMetadata;
export const compiledCircuit = circuitJson as unknown as CompiledCircuit;

export class EligibilityProverError extends Error {
  readonly code: "WITNESS_UNAVAILABLE" | "PROOF_FAILED" | "VERIFICATION_FAILED";

  constructor(code: EligibilityProverError["code"], message: string) {
    super(message);
    this.name = "EligibilityProverError";
    this.code = code;
  }
}

export interface ProveEligibilityRequest {
  readonly personaId: string;
  readonly epoch: number;
  readonly gateId: GateId;
  readonly chainId?: number;
}

export interface WitnessInputs {
  readonly wallet: string;
  readonly root: string;
  readonly chain_id: string;
  readonly gate: string;
  readonly class: string;
  readonly epoch: string;
  readonly expiry: string;
  readonly salt: string;
  readonly path: string[];
  readonly indices: boolean[];
}

export function buildWitnessInputs(request: ProveEligibilityRequest): WitnessInputs {
  const persona = personaById(request.personaId);
  if (persona === undefined) {
    throw new EligibilityProverError("WITNESS_UNAVAILABLE", `unknown persona ${request.personaId}`);
  }
  const epoch = epochByNumber(request.epoch);
  if (epoch === undefined) {
    throw new EligibilityProverError("WITNESS_UNAVAILABLE", `unknown epoch ${request.epoch}`);
  }
  const member = epoch.leaves.find((leaf) => leaf.personaId === request.personaId);
  if (member === undefined) {
    throw new EligibilityProverError(
      "WITNESS_UNAVAILABLE",
      `persona ${request.personaId} is not in epoch ${request.epoch}`,
    );
  }
  const gate = gateById(request.gateId);
  if (gate === undefined) {
    throw new EligibilityProverError("WITNESS_UNAVAILABLE", `unknown gate ${request.gateId}`);
  }
  const witness = witnessFor(request.epoch, request.personaId);
  if (witness === undefined) {
    throw new EligibilityProverError(
      "WITNESS_UNAVAILABLE",
      `no demo witness for ${request.personaId} at epoch ${request.epoch}`,
    );
  }
  const chainId = request.chainId ?? 31337;
  return {
    wallet: BigInt(member.wallet).toString(),
    root: epoch.root,
    chain_id: String(chainId),
    gate: BigInt(gate.address).toString(),
    class: String(member.classCode),
    epoch: String(epoch.epoch),
    expiry: String(member.expiry),
    salt: witness.salt,
    path: [...witness.path],
    indices: [...witness.indices],
  };
}

export function publicInputsFromWitness(inputs: WitnessInputs): EligibilityPublicInputs {
  return {
    wallet: inputs.wallet,
    root: inputs.root,
    chainId: inputs.chain_id,
    gate: inputs.gate,
    classCode: inputs.class,
    epoch: inputs.epoch,
    expiry: inputs.expiry,
  };
}

let apiPromise: Promise<Barretenberg> | undefined;
let backend: UltraHonkBackend | undefined;

async function getBackend(): Promise<UltraHonkBackend> {
  if (backend !== undefined) {
    return backend;
  }
  apiPromise ??= Barretenberg.new();
  const api = await apiPromise;
  backend = new UltraHonkBackend(compiledCircuit.bytecode, api);
  return backend;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("proof hex must have an even length");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

export async function proveEligibility(
  request: ProveEligibilityRequest,
): Promise<EligibilityProof> {
  const inputs = buildWitnessInputs(request);
  const noir = new Noir(compiledCircuit);
  const started = Date.now();
  const executed = await noir.execute(inputs as never);
  const honk = await getBackend();
  const generated = await honk.generateProof(executed.witness);
  const provingMs = Date.now() - started;
  const publicInputs = publicInputsFromWitness(inputs);
  if (generated.publicInputs.length !== 7) {
    throw new EligibilityProverError(
      "PROOF_FAILED",
      `expected 7 public inputs, got ${generated.publicInputs.length}`,
    );
  }
  return {
    proofHex: toHex(generated.proof),
    proofDigest: await sha256Hex(generated.proof),
    publicInputs,
    provingMs,
    proofSizeBytes: generated.proof.byteLength,
    circuitVersion: circuitMetadata.circuitVersion,
    vkHash: circuitMetadata.vkHash,
  };
}

export interface VerifyProofParams {
  readonly proofHex: string;
  readonly publicInputs: EligibilityPublicInputs;
}

export async function verifyEligibilityProof(
  params: VerifyProofParams,
): Promise<{ valid: boolean; verifyMs: number; reasons: string[] }> {
  const honk = await getBackend();
  const started = Date.now();
  const expectedInputs = [
    params.publicInputs.wallet,
    params.publicInputs.root,
    params.publicInputs.chainId,
    params.publicInputs.gate,
    params.publicInputs.classCode,
    params.publicInputs.epoch,
    params.publicInputs.expiry,
  ];
  try {
    const valid = await honk.verifyProof({
      proof: hexToBytes(params.proofHex),
      publicInputs: expectedInputs,
    });
    return {
      valid,
      verifyMs: Date.now() - started,
      reasons: valid ? [] : ["the proof did not verify against the provided public inputs"],
    };
  } catch (error) {
    return {
      valid: false,
      verifyMs: Date.now() - started,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function classFromCode(code: number): EligibilityClass {
  switch (code) {
    case classRank("VERIFIED"):
      return "VERIFIED";
    case classRank("BASIC"):
      return "BASIC";
    default:
      return "FLAGGED";
  }
}
