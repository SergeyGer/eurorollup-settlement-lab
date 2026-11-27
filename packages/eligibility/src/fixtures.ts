/**
 * Bundled eligibility fixtures.
 *
 * The JSON files are versioned in `fixtures/eligibility/` and generated or
 * hand-maintained there; this module only re-exports typed accessors so the
 * browser and the API read exactly the same data.
 */
import gatesJson from "../../../fixtures/eligibility/gates.json";
import personasJson from "../../../fixtures/eligibility/personas.json";
import rootsJson from "../../../fixtures/eligibility/root-epochs.json";
import screeningJson from "../../../fixtures/eligibility/screening.json";
import witnessesJson from "../../../fixtures/eligibility/witnesses.json";
import type {
  GatesFixture,
  PersonasFixture,
  PersonaWitness,
  RootEpoch,
  RootEpochsFixture,
  ScreeningFixture,
  WitnessesFixture,
} from "./types.js";

export const personasFixture = personasJson as unknown as PersonasFixture;
export const rootsFixture = rootsJson as unknown as RootEpochsFixture;
export const gatesFixture = gatesJson as unknown as GatesFixture;
export const screeningFixture = screeningJson as unknown as ScreeningFixture;
export const witnessesFixture = witnessesJson as unknown as WitnessesFixture;

export function personaById(personaId: string) {
  return personasFixture.leaves.find((leaf) => leaf.personaId === personaId);
}

export function personaByAccountId(accountId: string) {
  return personasFixture.leaves.find((leaf) => leaf.accountId === accountId);
}

export function gateById(gateId: string) {
  return gatesFixture.gates.find((gate) => gate.gateId === gateId);
}

export function epochByNumber(epoch: number): RootEpoch | undefined {
  return rootsFixture.epochs.find((item) => item.epoch === epoch);
}

export function currentEpoch(): RootEpoch {
  const last = rootsFixture.epochs[rootsFixture.epochs.length - 1];
  if (last === undefined) {
    throw new Error("no eligibility epochs configured");
  }
  return last;
}

export function witnessFor(epoch: number, personaId: string): PersonaWitness | undefined {
  const epochFixture = witnessesFixture.epochs.find((item) => item.epoch === epoch);
  return epochFixture?.personas.find((persona) => persona.personaId === personaId);
}

export function screeningByParty(partyId: string) {
  return screeningFixture.parties.find((party) => party.partyId === partyId);
}
