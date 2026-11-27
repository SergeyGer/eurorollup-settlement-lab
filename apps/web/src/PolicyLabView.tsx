/**
 * AI Policy Lab view.
 *
 * Implements the five guided states from the specification: select inputs, review
 * the typed proposal diff, clarify or reject, confirm and run, and read the
 * two-branch impact. Everything is computed locally from frozen fixtures with the
 * shared Policy Lab package; the comparison digest is checked against the
 * committed CLI evidence to prove cross-runtime equality.
 */
import { useCallback, useState } from "react";
import { formatDisplayAmount, parseBaseUnits } from "@eurorollup/dealing";
import type { ReplayDraft } from "@eurorollup/policy-lab";
import {
  applyDraftEdit,
  baselineCutoff,
  baselinePolicyVersion,
  committedP01Pack,
  computeComparison,
  createManualDraft,
  createRecordedDraft,
  p01Fixture,
  recordedProposal,
  type LocalComparisonResult,
} from "./data/policy-lab";

const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI"] as const;

function groupThousands(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const dotIndex = unsigned.indexOf(".");
  const whole = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fraction = dotIndex === -1 ? undefined : unsigned.slice(dotIndex + 1);
  let grouped = "";
  for (let index = 0; index < whole.length; index += 1) {
    grouped += whole[index];
    const remaining = whole.length - index - 1;
    if (remaining > 0 && remaining % 3 === 0) {
      grouped += ",";
    }
  }
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

function eur(baseUnits: string): string {
  return groupThousands(formatDisplayAmount(parseBaseUnits(baseUnits), 6, 2));
}

function units(baseUnits: string | null): string {
  if (baseUnits === null) {
    return "pending";
  }
  return groupThousands(formatDisplayAmount(parseBaseUnits(baseUnits), 6, 6));
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-6)}`;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : "request rejected";
    return `${code}: ${message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function originLabel(draft: ReplayDraft): string {
  if (draft.origin === "recorded") {
    return "Recorded proposal";
  }
  if (draft.origin === "manual") {
    return "Manual edit";
  }
  return "Live model";
}

function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PolicyLabView(): JSX.Element {
  const [mode, setMode] = useState<"recorded" | "manual">("recorded");
  const [manualWeekday, setManualWeekday] = useState("FRI");
  const [manualTime, setManualTime] = useState("15:00");
  const [draft, setDraft] = useState<ReplayDraft | null>(null);
  const [result, setResult] = useState<LocalComparisonResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editWeekday, setEditWeekday] = useState("FRI");
  const [editTime, setEditTime] = useState("15:00");

  const selectDraft = useCallback(
    (next: ReplayDraft | null): void => {
      setDraft(next);
      setResult(null);
      setError(null);
      if (next !== null) {
        setEditWeekday(next.diff?.weekday ?? "FRI");
        setEditTime(next.diff?.newTimeUtc ?? (next.proposal !== null && next.proposal.status === "proposed" ? next.proposal.timeUtc : "15:00"));
      }
    },
    [],
  );

  const loadDraft = useCallback((): void => {
    try {
      const next =
        mode === "recorded"
          ? createRecordedDraft()
          : createManualDraft({ weekday: manualWeekday, timeUtc: manualTime, timezone: "UTC" });
      selectDraft(next);
    } catch (draftError) {
      setError(describeError(draftError));
    }
  }, [manualTime, manualWeekday, mode, selectDraft]);

  const applyEdit = useCallback(
    (fields: { weekday: string; timeUtc: string; timezone: string }): void => {
      if (draft === null) {
        return;
      }
      try {
        selectDraft(applyDraftEdit(draft, fields));
      } catch (editError) {
        setError(describeError(editError));
      }
    },
    [draft, selectDraft],
  );

  const confirmAndRun = useCallback((): void => {
    if (draft === null || draft.status !== "proposed" || running) {
      return;
    }
    setRunning(true);
    setError(null);
    window.setTimeout(() => {
      try {
        setResult(computeComparison(draft));
      } catch (comparisonError) {
        setError(describeError(comparisonError));
      } finally {
        setRunning(false);
      }
    }, 150);
  }, [draft, running]);

  const reset = useCallback((): void => {
    setDraft(null);
    setResult(null);
    setError(null);
    setRunning(false);
  }, []);

  const proposed = draft !== null && draft.status === "proposed" && draft.diff !== null;
  const committedMatches = result === null ? null : result.matchesCommitted;

  return (
    <section className="live policy-lab">
      <div className="panel lab-head">
        <div className="panel-head">
          <h2>AI Policy Lab</h2>
          <span className="fixture-tag">
            {p01Fixture.fixtureId} v{p01Fixture.fixtureVersion} · LAB-UTC-1 · asset eFUND
          </span>
        </div>
        <p className="ticket-note">
          Ask what happens if the fund moves its Friday subscription cutoff. The typed proposal is
          reviewed and confirmed first; both settlement branches are then replayed deterministically
          from the same frozen orders and NAV observations. Model output and computed results are
          labelled separately.
        </p>
        <div className="lab-meta">
          <span className="badge">Baseline policy v{baselinePolicyVersion}</span>
          <span className="badge badge-clock">Friday cutoff {baselineCutoff} UTC</span>
          <span className="badge">Fixture orders {p01Fixture.orders.length}</span>
          <span className="badge">All times UTC</span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>1 · Select inputs</h2>
          <span className="fixture-tag">recorded preset or manual edit</span>
        </div>
        <div className="tabs lab-tabs" role="tablist" aria-label="Proposal origin">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "recorded"}
            className={mode === "recorded" ? "active" : ""}
            onClick={() => {
              setMode("recorded");
              selectDraft(null);
            }}
          >
            Recorded proposal
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "manual"}
            className={mode === "manual" ? "active" : ""}
            onClick={() => {
              setMode("manual");
              selectDraft(null);
            }}
          >
            Manual edit
          </button>
        </div>
        {mode === "recorded" ? (
          <div className="lab-question">
            <span className="lab-question-label">Recorded question</span>
            <blockquote>{recordedProposal.question}</blockquote>
            <p className="notes-small">
              {recordedProposal.label} — replayed as labelled model output. A genuine live-model
              capture arrives in step S04; computed results never depend on model prose.
            </p>
          </div>
        ) : (
          <div className="lab-form">
            <label>
              <span>Dealing weekday</span>
              <select value={manualWeekday} onChange={(event) => setManualWeekday(event.target.value)}>
                {WEEKDAYS.map((weekday) => (
                  <option key={weekday} value={weekday}>
                    {weekday}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>New cutoff time (UTC, whole minutes 00:01–16:59)</span>
              <input value={manualTime} onChange={(event) => setManualTime(event.target.value)} />
            </label>
            <button type="button" className="primary" onClick={loadDraft}>
              Review manual change
            </button>
          </div>
        )}
        {mode === "recorded" ? (
          <button type="button" className="primary lab-load" onClick={loadDraft}>
            Load recorded proposal
          </button>
        ) : null}
        {error === null ? null : <p className="live-error">{error}</p>}
      </div>

      {draft === null ? null : (
        <div className="panel">
          <div className="panel-head">
            <h2>2 · Review proposal</h2>
            <span className="fixture-tag">
              revision {draft.revision} · {originLabel(draft)} · {draft.status}
            </span>
          </div>

          {draft.status === "proposed" && draft.diff !== null ? (
            <>
              <table className="diff-table">
                <tbody>
                  <tr>
                    <th>Asset</th>
                    <td>{draft.diff.asset}</td>
                    <th>Order type</th>
                    <td>{draft.diff.orderType}</td>
                  </tr>
                  <tr>
                    <th>Weekday</th>
                    <td>{draft.diff.weekday}</td>
                    <th>Timezone</th>
                    <td>{draft.diff.timezone}</td>
                  </tr>
                  <tr>
                    <th>Current cutoff</th>
                    <td className="mono">{draft.diff.oldTimeUtc} UTC</td>
                    <th>Proposed cutoff</th>
                    <td className="mono proposed-value">{draft.diff.newTimeUtc} UTC</td>
                  </tr>
                  <tr>
                    <th>Fixture</th>
                    <td>
                      {draft.fixture.fixtureId} v{draft.fixture.fixtureVersion}
                    </td>
                    <th>Fixture digest</th>
                    <td className="mono">{shortHash(draft.fixture.fixtureHash)}</td>
                  </tr>
                  <tr>
                    <th>Baseline policy</th>
                    <td>
                      v{draft.baseline.version} · {draft.baseline.policyId}
                    </td>
                    <th>Baseline hash</th>
                    <td className="mono">{shortHash(draft.baseline.policyHash)}</td>
                  </tr>
                  <tr>
                    <th>Draft digest</th>
                    <td className="mono">{shortHash(draft.draftDigest)}</td>
                    <th>Confirmation digest</th>
                    <td className="mono">{shortHash(draft.confirmationDigest)}</td>
                  </tr>
                </tbody>
              </table>

              <div className="edit-row">
                <label>
                  <span>Edit weekday</span>
                  <select value={editWeekday} onChange={(event) => setEditWeekday(event.target.value)}>
                    {WEEKDAYS.map((weekday) => (
                      <option key={weekday} value={weekday}>
                        {weekday}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Edit cutoff (UTC)</span>
                  <input value={editTime} onChange={(event) => setEditTime(event.target.value)} />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    applyEdit({ weekday: editWeekday, timeUtc: editTime, timezone: "UTC" })
                  }
                >
                  Apply edit (new revision)
                </button>
              </div>

              <div className="lab-actions">
                <button type="button" onClick={reset}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={confirmAndRun}
                  disabled={running}
                >
                  {running ? "Comparing both branches…" : "Confirm and compare"}
                </button>
              </div>
              <p className="notes-small">
                The run binds this visible diff to revision {draft.revision}, the baseline policy
                version and the fixture digest above. A different revision or a changed baseline
                cannot run.
              </p>
            </>
          ) : null}

          {draft.status === "clarify" && draft.clarify !== null ? (
            <div className="lab-clarify">
              <p className="ticket-note warning">{draft.clarify.question}</p>
              <p className="notes-small">
                Missing fields: {draft.clarify.missingFields.join(", ")}. The run button stays
                disabled until the typed fields are unambiguous.
              </p>
              <div className="edit-row">
                <label>
                  <span>Weekday</span>
                  <select value={editWeekday} onChange={(event) => setEditWeekday(event.target.value)}>
                    {WEEKDAYS.map((weekday) => (
                      <option key={weekday} value={weekday}>
                        {weekday}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Cutoff (UTC)</span>
                  <input value={editTime} onChange={(event) => setEditTime(event.target.value)} />
                </label>
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    applyEdit({ weekday: editWeekday, timeUtc: editTime, timezone: "UTC" })
                  }
                >
                  Apply clarification answer
                </button>
              </div>
              <div className="lab-actions">
                <button type="button" onClick={reset}>
                  Reset
                </button>
              </div>
            </div>
          ) : null}

          {draft.status === "unsupported" || draft.status === "no_change" ? (
            <div className="lab-reject">
              <p className="ticket-note warning">
                {draft.status === "no_change"
                  ? "The proposed change equals the current rule (NO_CHANGE). Nothing to compare."
                  : `This request is unsupported in release 1.0: ${draft.unsupportedReasonCode ?? "unknown reason"}.`}
              </p>
              <div className="lab-actions">
                <button type="button" onClick={reset}>
                  Reset
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {result === null ? null : (
        <>
          <div className="panel impact">
            <div className="panel-head">
              <h2>3 · Impact</h2>
              <span className="fixture-tag">
                computed simulation · {committedMatches ? "matches committed CLI evidence" : "digest mismatch"}
              </span>
            </div>
            <div className="impact-grid">
              <div className="impact-card">
                <span className="cash-label">Orders changing dealing date</span>
                <strong className="impact-value">
                  {result.pack.affectedOrders} of {result.pack.totalOrders}
                </strong>
                <span className="cash-note">
                  {result.pack.deltas.changedOrderIds.join(", ") || "no order changes"}
                </span>
              </div>
              <div className="impact-card impact-warn">
                <span className="cash-label">Extra cash reserved at Friday close</span>
                <strong className="impact-value">€{eur(result.pack.extraReservedAtFridayCloseBase)}</strong>
                <span className="cash-note">released when the Monday NAV is authorized</span>
              </div>
              <div className="impact-card">
                <span className="cash-label">Later settlement</span>
                <strong className="impact-value">72 h</strong>
                <span className="cash-note">F-1530 settles Monday, 0.125000 fewer units</span>
              </div>
            </div>

            <table className="holdings order-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Requested</th>
                  <th>Baseline</th>
                  <th className="numeric">Baseline units</th>
                  <th>Candidate</th>
                  <th className="numeric">Candidate units</th>
                  <th className="numeric">Reserved at Fri close</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.pack.orderChanges.map((change) => (
                  <tr key={change.orderId}>
                    <td className="mono">{change.orderId}</td>
                    <td className="mono">{change.requestedAt}</td>
                    <td className="mono">{change.baselineDealingDate}</td>
                    <td className="numeric mono">{units(change.baselineUnitsBase)}</td>
                    <td className="mono">{change.candidateDealingDate}</td>
                    <td className="numeric mono">{units(change.candidateUnitsBase)}</td>
                    <td className="numeric mono">€{eur(change.reservedAtFridayCloseBase)}</td>
                    <td>{change.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="snapshot-grid">
              {(["fridayClose", "mondayClose"] as const).map((snapshotKey) => (
                <div key={snapshotKey} className="snapshot-card">
                  <h3>{snapshotKey === "fridayClose" ? "Friday 17:01 UTC close" : "Monday 17:01 UTC close"}</h3>
                  <table className="holdings">
                    <thead>
                      <tr>
                        <th>Snapshot</th>
                        <th className="numeric">Baseline</th>
                        <th className="numeric">Candidate</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Spendable cash</td>
                        <td className="numeric mono">
                          €{eur(result.pack.branches.baseline.snapshots[snapshotKey]?.spendableBase ?? "0")}
                        </td>
                        <td className="numeric mono">
                          €{eur(result.pack.branches.candidate.snapshots[snapshotKey]?.spendableBase ?? "0")}
                        </td>
                      </tr>
                      <tr>
                        <td>Reserved cash</td>
                        <td className="numeric mono">
                          €{eur(result.pack.branches.baseline.snapshots[snapshotKey]?.reservedBase ?? "0")}
                        </td>
                        <td className="numeric mono">
                          €{eur(result.pack.branches.candidate.snapshots[snapshotKey]?.reservedBase ?? "0")}
                        </td>
                      </tr>
                      <tr>
                        <td>eFUND units</td>
                        <td className="numeric mono">
                          {units(result.pack.branches.baseline.snapshots[snapshotKey]?.unitsBase ?? "0")}
                        </td>
                        <td className="numeric mono">
                          {units(result.pack.branches.candidate.snapshots[snapshotKey]?.unitsBase ?? "0")}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            <div className="lab-timeline">
              <h3>Timeline</h3>
              <ol>
                <li>
                  <span className="mono">Fri 14:50</span> F-1450 order — settles Friday in both
                  branches
                </li>
                <li>
                  <span className="mono">Fri 15:30</span> F-1530 order — after the proposed 15:00
                  cutoff, stays on Monday
                </li>
                <li>
                  <span className="mono">Fri 17:00</span> Friday NAV 96.00 authorized — 3.125000
                  units for the early order
                </li>
                <li>
                  <span className="mono">Fri 17:01</span> Friday close — EUR 300.00 still reserved in
                  the candidate
                </li>
                <li>
                  <span className="mono">Mon 17:00</span> Monday NAV 100.00 authorized — 3.000000
                  units for F-1530
                </li>
                <li>
                  <span className="mono">Mon 17:01</span> Monday close — reservation released, 6.125000
                  units total in the candidate
                </li>
              </ol>
            </div>

            <div className="parity-row">
              <span className={`badge ${committedMatches ? "badge-fund" : "badge-warn"}`}>
                {committedMatches ? "Browser digest matches CLI + service" : "Digest mismatch"}
              </span>
              <span className="fixture-tag mono">comparison {shortHash(result.pack.comparisonDigest)}</span>
              <span className="fixture-tag mono">pack {shortHash(result.pack.packDigest)}</span>
              <span className="fixture-tag mono">committed {shortHash(result.committedPackDigest)}</span>
            </div>

            <div className="lab-actions">
              <button type="button" onClick={reset}>
                Reset
              </button>
              <button
                type="button"
                onClick={() => downloadText("p01-comparison.json", result.packText)}
              >
                Download comparison pack
              </button>
            </div>
            <p className="notes-small">
              Computed simulation only. The proposal origin is {draft === null ? "unknown" : originLabel(draft)}; numbers are
              produced by the deterministic engine after confirmation, never by the model.
            </p>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Boundary replay checks</h2>
              <span className="fixture-tag">
                {result.pack.boundarySummary.passed}/{result.pack.boundarySummary.total} pass
              </span>
            </div>
            <table className="holdings order-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Requested</th>
                  <th>Baseline</th>
                  <th>Candidate</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {result.pack.boundaryCases.map((boundaryCase) => (
                  <tr key={boundaryCase.caseId}>
                    <td className="mono">{boundaryCase.caseId}</td>
                    <td className="mono">{boundaryCase.requestedAt}</td>
                    <td className="mono">
                      {boundaryCase.baseline.dealingDate} · {units(boundaryCase.baseline.unitsBase)}
                    </td>
                    <td className="mono">
                      {boundaryCase.candidate.dealingDate} ·{" "}
                      {boundaryCase.candidate.pending ? "pending" : units(boundaryCase.candidate.unitsBase)}
                    </td>
                    <td>
                      <span className={boundaryCase.pass ? "state state-good" : "state state-bad"}>
                        {boundaryCase.pass ? "pass" : "fail"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="notes-small">
              Committed evidence: evidence/policy-lab/p01-comparison.json · comparison digest{" "}
              {committedP01Pack.comparisonDigest.slice(0, 16)}… · branch policy hashes{" "}
              {result.pack.baselinePolicyHash.slice(0, 10)}… / {result.pack.candidatePolicyHash.slice(0, 10)}…
            </p>
          </div>
        </>
      )}
    </section>
  );
}
