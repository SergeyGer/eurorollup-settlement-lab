/**
 * Eligibility, sponsorship and account-abstraction view.
 *
 * Shows the three separate decisions (issuer class, dealing gate, sponsor), the
 * documented policy matrix computed locally from the versioned fixtures, the root
 * rotation hold, and a real Noir proof generated and verified in the browser.
 */
import { useCallback, useState } from "react";
import {
  aaEvidence,
  buildMatrixRows,
  MATRIX_CLOCK_ISO,
  policyMeta,
  rotation,
  shortHash,
  sponsorship,
} from "./data/eligibility";

interface ProofState {
  readonly status: "idle" | "proving" | "done" | "error";
  readonly personaId: string | null;
  readonly provingMs: number | null;
  readonly verifyMs: number | null;
  readonly proofDigest: string | null;
  readonly vkHash: string | null;
  readonly publicInputs: Readonly<Record<string, string>> | null;
  readonly verified: boolean | null;
  readonly error: string | null;
}

const INITIAL_PROOF_STATE: ProofState = {
  status: "idle",
  personaId: null,
  provingMs: null,
  verifyMs: null,
  proofDigest: null,
  vkHash: null,
  publicInputs: null,
  verified: null,
  error: null,
};

function classBadge(eligibilityClass: string): string {
  if (eligibilityClass === "VERIFIED") return "badge-fund";
  if (eligibilityClass === "BASIC") return "badge-clock";
  return "badge-warn";
}

function decisionClass(decision: string): string {
  if (decision === "ALLOW") return "state state-good";
  if (decision === "HOLD") return "state state-warn";
  return "state state-bad";
}

export function EligibilityView(): JSX.Element {
  const matrix = buildMatrixRows();
  const rotationEvidence = rotation();
  const sponsor = sponsorship();
  const meta = policyMeta();
  const [proof, setProof] = useState<ProofState>(INITIAL_PROOF_STATE);

  const prove = useCallback(async (personaId: string): Promise<void> => {
    setProof({ ...INITIAL_PROOF_STATE, status: "proving", personaId });
    try {
      const prover = await import("@eurorollup/eligibility/prover");
      const generated = await prover.proveEligibility({
        personaId,
        epoch: 1,
        gateId: "FUND_SUBSCRIPTION",
      });
      const verification = await prover.verifyEligibilityProof({
        proofHex: generated.proofHex,
        publicInputs: generated.publicInputs,
      });
      setProof({
        status: "done",
        personaId,
        provingMs: generated.provingMs,
        verifyMs: verification.verifyMs,
        proofDigest: generated.proofDigest,
        vkHash: generated.vkHash,
        publicInputs: generated.publicInputs as unknown as Record<string, string>,
        verified: verification.valid,
        error: null,
      });
    } catch (error) {
      setProof({
        ...INITIAL_PROOF_STATE,
        status: "error",
        personaId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const allowCount = matrix.filter((row) => row.decision === "ALLOW").length;
  const holdCount = matrix.filter((row) => row.decision === "HOLD").length;
  const declineCount = matrix.filter((row) => row.decision === "DECLINE").length;

  return (
    <section className="live eligibility-view">
      <div className="panel lab-head">
        <div className="panel-head">
          <h2>Eligibility &amp; sponsorship</h2>
          <span className="fixture-tag">
            {meta.personas.length} personas · {meta.gates.length} gates · 2 issuer epochs
          </span>
        </div>
        <p className="ticket-note">
          Three decisions stay separate: the issuer decides class membership with a Noir
          membership proof, the dealing policy decides whether a movement may execute, and the
          sponsor decides whether to pay for gas. The policy matrix is computed locally from the
          versioned fixtures; the proof is generated and verified in this browser tab.
        </p>
        <div className="lab-meta">
          <span className="badge">Policy ELIG-POLICY-1.0.0</span>
          <span className="badge badge-clock">Chain 31337</span>
          <span className="badge">Current epoch {meta.currentEpoch}</span>
          <span className="badge">Circuit v1.0.0 · UltraHonk</span>
          <span className="badge">All times UTC</span>
        </div>
        <div className="lab-meta">
          <span className="fixture-tag mono">vk {meta.epochs.map((epoch) => shortHash(epoch.root)).join(" → ")}</span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Three personas</h2>
          <span className="fixture-tag">issuer roots: epoch 1 → epoch 2</span>
        </div>
        <div className="persona-grid">
          {meta.personas.map((persona) => (
            <div key={persona.personaId} className="persona-card">
              <div className="persona-head">
                <strong>{persona.label}</strong>
                <span className={`badge ${classBadge(persona.class)}`}>{persona.class}</span>
              </div>
              <span className="fixture-tag mono">{persona.accountId}</span>
              <span className="notes-small">
                Credential epoch {persona.epoch} · expires {new Date(persona.expiry * 1000).toISOString().slice(0, 10)}
              </span>
              <button
                type="button"
                className="primary"
                onClick={() => void prove(persona.personaId)}
                disabled={proof.status === "proving"}
              >
                {proof.status === "proving" && proof.personaId === persona.personaId
                  ? "Proving in browser…"
                  : "Prove membership in browser"}
              </button>
            </div>
          ))}
        </div>
        {proof.status === "idle" ? (
          <p className="notes-small">
            The demo witness never leaves this tab: the browser proves membership in the issuer root
            for the fund subscription gate, verifies the proof locally and discards the witness.
            Only public inputs are displayed.
          </p>
        ) : null}
        {proof.status === "proving" ? (
          <p className="notes-small">Generating a real UltraHonk proof in the browser…</p>
        ) : null}
        {proof.status === "done" ? (
          <div className="proof-result">
            <div className="parity-row">
              <span className={`badge ${proof.verified ? "badge-fund" : "badge-warn"}`}>
                {proof.verified ? "Proof verified locally" : "Proof verification failed"}
              </span>
              <span className="fixture-tag mono">proving {proof.provingMs} ms</span>
              <span className="fixture-tag mono">verify {proof.verifyMs} ms</span>
              <span className="fixture-tag mono">proof {shortHash(proof.proofDigest ?? "")}</span>
              {proof.vkHash === null ? null : (
                <span className="fixture-tag mono">vk {shortHash(proof.vkHash)}</span>
              )}
            </div>
            <table className="diff-table">
              <tbody>
                {Object.entries(proof.publicInputs ?? {}).map(([key, value]) => (
                  <tr key={key}>
                    <th>{key}</th>
                    <td className="mono">{value.length > 40 ? shortHash(value) : value}</td>
                    <th>scope</th>
                    <td>public input</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="notes-small">
              The witness (salt and Merkle path) is discarded after proving. The public inputs bind
              the proof to the wallet, chain, gate, class, epoch and expiry.
            </p>
          </div>
        ) : null}
        {proof.status === "error" ? (
          <p className="live-error">
            Browser proving failed: {proof.error}. The recorded policy matrix below stays usable
            without the proving backend.
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Policy matrix</h2>
          <span className="fixture-tag">
            clock {MATRIX_CLOCK_ISO} · {allowCount} allow / {holdCount} hold / {declineCount} decline
          </span>
        </div>
        <table className="holdings order-table">
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Persona</th>
              <th>Route</th>
              <th>Decision</th>
              <th>Code</th>
              <th>Proof</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map((row) => (
              <tr key={`${row.scenario}-${row.personaId}-${row.route}`}>
                <td className="mono">{row.scenario}</td>
                <td>
                  {row.personaId} · {row.class}
                </td>
                <td className="mono">{row.route}</td>
                <td>
                  <span className={decisionClass(row.decision)}>{row.decision}</span>
                </td>
                <td className="mono">{row.code}</td>
                <td className="mono">
                  {row.requiresProof
                    ? row.receiptValid === null
                      ? "missing"
                      : row.receiptValid
                        ? "valid"
                        : "invalid"
                    : "—"}
                </td>
                <td className="notes-small">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="snapshot-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>Root rotation between request and allocation</h2>
            <span className="fixture-tag">epoch 1 → epoch 2</span>
          </div>
          <div className="impact-card impact-warn">
            <span className="cash-label">Decision</span>
            <strong className="impact-value">{rotationEvidence.decision}</strong>
            <span className="cash-note mono">{rotationEvidence.code}</span>
          </div>
          <table className="diff-table">
            <tbody>
              <tr>
                <th>Reserved cash</th>
                <td className="mono">€{Number(rotationEvidence.cashReservedBase) / 1_000_000} stays in custody</td>
              </tr>
              <tr>
                <th>Units minted</th>
                <td className="mono">{rotationEvidence.unitsMintedBase}</td>
              </tr>
              <tr>
                <th>Allowed actions</th>
                <td className="mono">{rotationEvidence.allowedActions.join(", ")}</td>
              </tr>
            </tbody>
          </table>
          <p className="notes-small">{rotationEvidence.detail}</p>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Sponsorship is independent</h2>
            <span className="fixture-tag">native ETH budget</span>
          </div>
          <div className="impact-card">
            <span className="cash-label">Decision</span>
            <strong className="impact-value">{sponsor.sponsorship}</strong>
            <span className="cash-note mono">{sponsor.code}</span>
          </div>
          <table className="diff-table">
            <tbody>
              <tr>
                <th>Daily budget</th>
                <td className="mono">{sponsor.dailyBudget}</td>
              </tr>
              <tr>
                <th>Budget used</th>
                <td className="mono">{sponsor.dailyBudgetUsed}</td>
              </tr>
              <tr>
                <th>Holdings</th>
                <td className="mono">{sponsor.holdingsUntouched ? "untouched" : "modified"}</td>
              </tr>
            </tbody>
          </table>
          <p className="notes-small">{sponsor.detail}</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Sponsored UserOperations</h2>
          <span className="fixture-tag">
            {aaEvidence.summary.passedAll ? "A04 receipts passing" : "A04 receipts failing"} · chain{" "}
            {aaEvidence.chain.chainId}
          </span>
        </div>
        <table className="holdings order-table">
          <thead>
            <tr>
              <th>Case</th>
              <th>Kind</th>
              <th>Outer tx</th>
              <th>Status</th>
              <th>UserOp event</th>
              <th>Sponsor cost (wei)</th>
              <th>Deposit delta</th>
              <th>User charge</th>
            </tr>
          </thead>
          <tbody>
            {aaEvidence.cases.map((item) => (
              <tr key={item.caseId}>
                <td className="mono">{item.caseId}</td>
                <td>{item.kind}</td>
                <td className="mono">{shortHash(item.outerTxHash)}</td>
                <td className="mono">{item.outerTxStatus}</td>
                <td>
                  {item.userOperationEvent === null ? (
                    <span className="state state-warn">absent</span>
                  ) : (
                    <span className={item.userOperationEvent.success ? "state state-good" : "state state-warn"}>
                      success={String(item.userOperationEvent.success)}
                    </span>
                  )}
                </td>
                <td className="numeric mono">{item.userOperationEvent?.actualGasCost ?? "—"}</td>
                <td className="numeric mono">{item.paymasterDepositDeltaBase}</td>
                <td className="numeric mono">{item.userChargeBase}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="notes-small">
          Pinned EntryPoint v0.7.0 with the VerifyingPaymaster sample on a local Anvil chain. The
          exhausted sponsor bundle reverts with {aaEvidence.cases.find((item) => item.kind === "exhausted-sponsor")?.revertReason ?? "a validation error"} and leaves the deposit untouched. The full receipts are attached to the release.
        </p>
      </div>
    </section>
  );
}
