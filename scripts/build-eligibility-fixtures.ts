/**
 * Builds the deterministic eligibility fixtures from the static persona and
 * epoch definitions.
 *
 * Merkle hashing is done by the pinned Noir toolchain (`hash_leaf` and
 * `hash_node` helper circuits) so the roots and the circuit use the exact same
 * pedersen implementation. This script never runs in production paths.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const circuitsRoot = join(repoRoot, "circuits");
const nargoBin = process.env.NARGO_BIN ?? join(process.env.HOME ?? "", ".nargo", "bin", "nargo");
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TREE_DEPTH = 3;

interface PersonaLeaf {
  readonly leafIndex: number;
  readonly personaId: string;
  readonly label: string;
  readonly accountId: string;
  readonly wallet: string;
  readonly class: "VERIFIED" | "BASIC" | "FLAGGED";
  readonly epoch: number;
  readonly expiry: number;
  readonly demo: boolean;
}

interface PersonasFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly chainId: number;
  readonly classCodes: Record<string, number>;
  readonly leaves: PersonaLeaf[];
}

interface EpochsFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly epochs: Array<{
    readonly epoch: number;
    readonly publishedAt: string;
    readonly members: string[];
    readonly replacement?: { readonly persona: PersonaLeaf };
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as T;
}

function fieldHash(packageDir: string, inputs: Record<string, string>): bigint {
  const proverToml = Object.entries(inputs)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");
  writeFileSync(join(circuitsRoot, packageDir, "Prover.toml"), `${proverToml}\n`);
  const output = execFileSync(nargoBin, ["execute"], {
    cwd: join(circuitsRoot, packageDir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const match = /Circuit output: 0x([0-9a-f]+)/i.exec(output);
  if (match === null || match[1] === undefined) {
    throw new Error(`hash tool ${packageDir} produced no output:\n${output}`);
  }
  return BigInt(`0x${match[1]}`);
}

function saltFor(personaId: string): string {
  const digest = createHash("sha256").update(`eligibility-salt:${personaId}`).digest("hex");
  return (BigInt(`0x${digest}`) % FIELD_PRIME).toString();
}

function walletField(wallet: string): string {
  return BigInt(wallet).toString();
}

function buildEpoch(params: {
  epoch: number;
  leaves: readonly PersonaLeaf[];
  classCodes: Record<string, number>;
}): {
  epoch: number;
  publishedAt: string;
  leaves: Array<{
    leafIndex: number;
    personaId: string;
    wallet: string;
    class: string;
    classCode: number;
    epoch: number;
    expiry: number;
    leafHash: string;
  }>;
  levels: string[][];
  root: string;
} {
  const leafHashes = params.leaves.map((leaf) =>
    fieldHash("hash_leaf", {
      wallet: walletField(leaf.wallet),
      class: String(params.classCodes[leaf.class]),
      epoch: String(params.epoch),
      expiry: String(leaf.expiry),
      salt: saltFor(leaf.personaId),
    }),
  );
  const levels: bigint[][] = [leafHashes];
  let level = leafHashes;
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        fieldHash("hash_node", {
          left: level[index]!.toString(),
          right: level[index + 1]!.toString(),
        }),
      );
    }
    levels.push(next);
    level = next;
  }
  return {
    epoch: params.epoch,
    publishedAt: "",
    leaves: params.leaves.map((leaf, index) => ({
      leafIndex: leaf.leafIndex,
      personaId: leaf.personaId,
      wallet: leaf.wallet,
      class: leaf.class,
      classCode: params.classCodes[leaf.class]!,
      epoch: params.epoch,
      expiry: leaf.expiry,
      leafHash: leafHashes[index]!.toString(),
    })),
    levels: levels.map((row) => row.map((value) => value.toString())),
    root: level[0]!.toString(),
  };
}

function witnessFor(params: {
  leaves: readonly PersonaLeaf[];
  levels: bigint[][];
  leafIndex: number;
  epoch: number;
  classCodes: Record<string, number>;
}): {
  salt: string;
  path: string[];
  indices: boolean[];
} {
  const personaId = params.leaves[params.leafIndex]!.personaId;
  const path: string[] = [];
  const indices: boolean[] = [];
  let index = params.leafIndex;
  for (let level = 0; level < TREE_DEPTH; level += 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    path.push(params.levels[level]![siblingIndex]!.toString());
    indices.push(index % 2 === 1);
    index = Math.floor(index / 2);
  }
  return { salt: saltFor(personaId), path, indices };
}

function main(): void {
  const personas = readJson<PersonasFixture>("fixtures/eligibility/personas.json");
  const epochsFixture = readJson<EpochsFixture>("fixtures/eligibility/epochs.json");
  const byId = new Map(personas.leaves.map((leaf) => [leaf.personaId, leaf]));
  const generatedEpochs: Array<{
    epoch: number;
    publishedAt: string;
    leaves: ReturnType<typeof buildEpoch>["leaves"];
    levels: string[][];
    root: string;
  }> = [];
  const witnesses: Array<{
    epoch: number;
    publishedAt: string;
    personas: Array<{
      personaId: string;
      wallet: string;
      class: string;
      classCode: number;
      expiry: number;
      salt: string;
      path: string[];
      indices: boolean[];
    }>;
  }> = [];

  for (const epochDefinition of epochsFixture.epochs) {
    const leaves: PersonaLeaf[] = [];
    for (const member of epochDefinition.members) {
      const persona =
        byId.get(member) ??
        (epochDefinition.replacement?.persona.personaId === member
          ? epochDefinition.replacement.persona
          : undefined);
      if (persona === undefined) {
        throw new Error(`epoch ${epochDefinition.epoch} references unknown persona ${member}`);
      }
      leaves.push(persona);
    }
    const built = buildEpoch({
      epoch: epochDefinition.epoch,
      leaves,
      classCodes: personas.classCodes,
    });
    built.publishedAt = epochDefinition.publishedAt;
    generatedEpochs.push(built);
    const epochWitnesses = [];
    for (const persona of leaves.filter((leaf) => leaf.demo)) {
      const witness = witnessFor({
        leaves,
        levels: built.levels.map((row) => row.map((value) => BigInt(value))),
        leafIndex: persona.leafIndex,
        epoch: epochDefinition.epoch,
        classCodes: personas.classCodes,
      });
      epochWitnesses.push({
        personaId: persona.personaId,
        wallet: persona.wallet,
        class: persona.class,
        classCode: personas.classCodes[persona.class]!,
        expiry: persona.expiry,
        salt: witness.salt,
        path: witness.path,
        indices: witness.indices,
      });
    }
    witnesses.push({
      epoch: epochDefinition.epoch,
      publishedAt: epochDefinition.publishedAt,
      personas: epochWitnesses,
    });
    console.log(
      `epoch ${epochDefinition.epoch}: root ${built.root} (${leaves.length} leaves, ${epochWitnesses.length} demo witnesses)`,
    );
  }

  writeFileSync(
    join(repoRoot, "fixtures/eligibility/root-epochs.json"),
    `${JSON.stringify(
      {
        fixtureId: "ELIG-ROOTS",
        fixtureVersion: "1.0.0",
        description:
          "Issuer eligibility roots per epoch. Generated deterministically from personas.json and epochs.json with the pinned Noir hash tools.",
        treeDepth: TREE_DEPTH,
        chainId: personas.chainId,
        classCodes: personas.classCodes,
        epochs: generatedEpochs,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repoRoot, "fixtures/eligibility/witnesses.json"),
    `${JSON.stringify(
      {
        fixtureId: "ELIG-WITNESSES",
        fixtureVersion: "1.0.0",
        description:
          "Synthetic private witnesses for demo personas only. They are demo credentials, not real personal data, and the browser discards them after proving.",
        epochs: witnesses,
      },
      null,
      2,
    )}\n`,
  );
  console.log("wrote fixtures/eligibility/root-epochs.json and witnesses.json");
}

main();
