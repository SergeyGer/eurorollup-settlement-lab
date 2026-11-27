#!/usr/bin/env node
/**
 * Eligibility evidence runner.
 *
 * Usage:
 *   pnpm eligibility:matrix     write evidence/a03/policy-matrix.json
 *   pnpm eligibility:proofs     generate real proofs and write evidence/a03/proof-vectors.json
 *   pnpm eligibility:evidence   both
 *   pnpm eligibility:verify     verify committed A03 evidence
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPolicyMatrixEvidence,
  buildProofVectorsEvidence,
  type PolicyMatrixEvidence,
  type ProofVectorsEvidence,
} from "./evidence.js";
import { circuitMetadata, verifyEligibilityProof } from "./prover.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceDir = join(repoRoot, "evidence/a03");
const matrixPath = join(evidenceDir, "policy-matrix.json");
const vectorsPath = join(evidenceDir, "proof-vectors.json");

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text, "utf8");
  console.log(`wrote ${path.replace(`${repoRoot}/`, "")} (${Buffer.byteLength(text)} bytes)`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function commandMatrix(checkOnly = false): Promise<number> {
  const evidence = buildPolicyMatrixEvidence();
  if (checkOnly) {
    if (!existsSync(matrixPath)) {
      console.error("FAIL evidence/a03/policy-matrix.json is missing");
      return 1;
    }
    const regenerated = `${JSON.stringify(evidence, null, 2)}\n`;
    if (readFileSync(matrixPath, "utf8") !== regenerated) {
      console.error("FAIL evidence/a03/policy-matrix.json differs from a fresh build");
      return 1;
    }
    console.log("OK   evidence/a03/policy-matrix.json matches the policy engine");
    return 0;
  }
  writeJson(matrixPath, evidence);
  console.log(
    `matrix rows ${evidence.summary.rows}: ${evidence.summary.allow} allow, ${evidence.summary.hold} hold, ${evidence.summary.decline} decline; passed=${evidence.summary.passed}`,
  );
  return evidence.summary.passed ? 0 : 1;
}

async function commandProofs(): Promise<number> {
  console.log("generating real UltraHonk proof vectors (this takes a few seconds)…");
  const evidence = await buildProofVectorsEvidence();
  writeJson(vectorsPath, evidence);
  console.log(
    `positives ${evidence.summary.positivesVerified}/${evidence.summary.positives}, negatives ${evidence.summary.negativesRejected}/${evidence.summary.negatives}; passed=${evidence.summary.passed}`,
  );
  return evidence.summary.passed ? 0 : 1;
}

async function commandVerify(): Promise<number> {
  const committedCircuit = sha256File(join(repoRoot, "packages/eligibility/artifacts/eligibility.json"));
  const committedVk = sha256File(join(repoRoot, "packages/eligibility/artifacts/vk"));
  let failed = false;
  const fail = (message: string): void => {
    failed = true;
    console.error(`FAIL ${message}`);
  };
  // When the pinned toolchain is available the committed artifacts are compared
  // with a fresh build; CI verifies the committed bytes and proofs instead.
  const builtCircuitPath = join(repoRoot, "circuits/target/eligibility.json");
  const builtVkPath = join(repoRoot, "circuits/target/vk/vk");
  if (existsSync(builtCircuitPath) && sha256File(builtCircuitPath) !== committedCircuit) {
    fail("compiled circuit artifact does not match the circuits/target build");
  }
  if (existsSync(builtVkPath) && sha256File(builtVkPath) !== committedVk) {
    fail("committed verification key does not match the circuits/target build");
  }
  if (committedCircuit !== circuitMetadata.circuitSha256) {
    fail("circuit metadata sha256 does not match the committed artifact");
  }
  if (committedVk !== circuitMetadata.vkSha256) {
    fail("verification key metadata sha256 does not match the committed key");
  }
  if (!existsSync(matrixPath)) {
    fail("evidence/a03/policy-matrix.json is missing");
  } else {
    const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as PolicyMatrixEvidence;
    if (matrix.reportId !== "A03-policy-matrix") {
      fail("unexpected policy matrix report id");
    }
    if (!matrix.summary.passed) {
      fail("policy matrix summary is not passing");
    }
    if (!matrix.matrix.every((row) => row.pass)) {
      fail("at least one policy matrix row does not match its expected decision");
    }
    if (!matrix.assertions.every((assertion) => assertion.pass)) {
      fail("at least one policy assertion failed");
    }
    console.log(
      `OK   policy matrix: ${matrix.summary.rows} rows, ${matrix.assertions.length} assertions`,
    );
  }
  if (!existsSync(vectorsPath)) {
    fail("evidence/a03/proof-vectors.json is missing");
  } else {
    const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as ProofVectorsEvidence;
    if (vectors.reportId !== "A03-proof-vectors") {
      fail("unexpected proof vector report id");
    }
    if (!vectors.summary.passed) {
      fail("proof vector summary is not passing");
    }
    for (const vector of vectors.positive) {
      if (vector.proofHex === undefined || vector.publicInputs === undefined) {
        fail(`${vector.vectorId} has no proof material`);
        continue;
      }
      const digest = createHash("sha256").update(Buffer.from(vector.proofHex, "hex")).digest("hex");
      if (digest !== vector.proofDigest) {
        fail(`${vector.vectorId} proof digest does not match its proof bytes`);
      }
      const verification = await verifyEligibilityProof({
        proofHex: vector.proofHex,
        publicInputs: vector.publicInputs,
      });
      if (!verification.valid) {
        fail(`${vector.vectorId} positive proof does not verify: ${verification.reasons.join("; ")}`);
      }
    }
    if (!vectors.negative.every((vector) => vector.pass && vector.verified === false)) {
      fail("at least one negative vector is not rejected");
    }
    console.log(
      `OK   proof vectors: ${vectors.summary.positivesVerified}/${vectors.summary.positives} positive, ${vectors.summary.negativesRejected}/${vectors.summary.negatives} negative`,
    );
  }
  return failed ? 1 : 0;
}

async function run(argv: readonly string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case "matrix":
      return commandMatrix(argv.includes("--check"));
    case "proofs":
      return commandProofs();
    case "evidence": {
      const matrixCode = await commandMatrix();
      const proofCode = await commandProofs();
      return matrixCode === 0 && proofCode === 0 ? 0 : 1;
    }
    case "verify":
      return commandVerify();
    default:
      console.error(
        [
          "Usage: tsx packages/eligibility/src/cli.ts <matrix|proofs|evidence|verify>",
        ].join("\n"),
      );
      return 2;
  }
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
