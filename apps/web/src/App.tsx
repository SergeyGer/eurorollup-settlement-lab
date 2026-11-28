import { useCallback, useEffect, useMemo, useState } from "react";
import {
  displayDecimalsOf,
  formatDisplayAmount,
  parseBaseUnits,
  parseUtcInstant,
  type PortfolioSnapshot,
  type Receipt,
} from "@eurorollup/dealing";
import {
  buildReplayHash,
  clampReplayIndex,
  isReplayMode,
  parseReplayHash,
  type ReplayMode,
} from "./replay-state.js";
import {
  fixtureInfo,
  g01Replay,
  redemptionReplay,
  type ReplayStep,
} from "./data/replay";
import { LiveLab } from "./LiveLab";
import { PolicyLabView } from "./PolicyLabView";
import { EligibilityView } from "./EligibilityView";
import { EconomicsView } from "./EconomicsView";
import { ReleaseFilmView } from "./ReleaseFilmView";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const REPOSITORY_URL = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const EVIDENCE_PACK_URL = `${REPOSITORY_URL}/blob/main/evidence/g01/golden-run.json`;

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

function unitDecimals(assetId: "dEUR" | "tWETH" | "eFUND"): number {
  return assetId === "tWETH" ? 18 : 6;
}

/** Investor-facing amount: cash two decimals, spot and fund units six. */
function displayAmount(baseUnits: string, assetId: "dEUR" | "tWETH" | "eFUND"): string {
  return groupThousands(
    formatDisplayAmount(parseBaseUnits(baseUnits), unitDecimals(assetId), displayDecimalsOf(assetId)),
  );
}

function tokenAmount(baseUnits: string, assetId: "tWETH" | "eFUND"): string {
  return displayAmount(baseUnits, assetId);
}

function clockLabel(iso: string): string {
  const parts = parseUtcInstant(iso);
  const weekday = WEEKDAYS[parts.weekday - 1] ?? "";
  const month = MONTHS[Number(parts.date.slice(5, 7)) - 1] ?? "";
  const day = Number(parts.date.slice(8, 10));
  return `${weekday} ${day} ${month} ${parts.date.slice(0, 4)} · ${parts.time} UTC`;
}

function shortClock(iso: string): string {
  const parts = parseUtcInstant(iso);
  return `${parts.date.slice(5)} ${parts.time}`;
}

function accountLabel(kind: string, accountId: string): string {
  return `${kind} · ${accountId}`;
}

function assetLabel(assetId: string): string {
  return assetId;
}

function pendingReason(status: string): string {
  if (status === "AWAITING_NAV") {
    return "awaiting authorized NAV";
  }
  return status.toLowerCase();
}

function receiptChange(receipt: Receipt): { change: string; reason: string } {
  switch (receipt.businessState) {
    case "FILLED":
      return {
        change: `${displayAmount(receipt.unitsBase, "tWETH")} tWETH received for €${displayAmount(receipt.cashDeployedBase, "dEUR")} · charge €${displayAmount(receipt.investorChargeBase, "dEUR")}`,
        reason: "Spot order filled at the quoted price before expiry.",
      };
    case "ALLOCATED":
      return {
        change: `${displayAmount(receipt.unitsBase, "eFUND")} eFUND issued for €${displayAmount(receipt.cashDeployedBase, "dEUR")} at €${receipt.navEurPerUnit} per unit`,
        reason: "Reserved cash converted at the authorized NAV.",
      };
    case "REDEEMED":
      return {
        change: `${displayAmount(receipt.unitsBase, "eFUND")} eFUND redeemed for €${displayAmount(receipt.cashPaidBase, "dEUR")} at €${receipt.navEurPerUnit} per unit`,
        reason: "Redemption settled at the next applicable NAV.",
      };
  }
}

function receiptRows(receipt: Receipt): Array<[string, string]> {
  const assetId = receipt.assetId;
  const cash = (baseUnits: string): string => `€${displayAmount(baseUnits, "dEUR")}`;
  switch (receipt.businessState) {
    case "FILLED":
      return [
        ["Units received", `${displayAmount(receipt.unitsBase, assetId)} ${assetId}`],
        ["Cash deployed", cash(receipt.cashDeployedBase)],
        ["Price", `€${receipt.priceEurPerUnit} per ${assetId}`],
        ["Investor charge", cash(receipt.investorChargeBase)],
      ];
    case "ALLOCATED":
      return [
        ["Units issued", `${displayAmount(receipt.unitsBase, assetId)} ${assetId}`],
        ["Cash deployed", cash(receipt.cashDeployedBase)],
        ["Authorized NAV", `€${receipt.navEurPerUnit} per unit`],
        ["Investor charge", cash(receipt.investorChargeBase)],
      ];
    case "REDEEMED":
      return [
        ["Units redeemed", `${displayAmount(receipt.unitsBase, assetId)} ${assetId}`],
        ["Cash paid", cash(receipt.cashPaidBase)],
        ["Authorized NAV", `€${receipt.navEurPerUnit} per unit`],
        ["Investor charge", cash(receipt.investorChargeBase)],
      ];
  }
}

function ReceiptCard({
  receipt,
  nextStep,
}: {
  receipt: Receipt;
  nextStep?: ReplayStep;
}): JSX.Element {
  const { change, reason } = receiptChange(receipt);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  return (
    <div className="panel receipt">
      <div className="panel-head">
        <h2>Receipt</h2>
        <div className="receipt-badges">
          <span className="badge badge-source">Fixture replay</span>
          <span className={`badge ${receipt.businessState === "FILLED" ? "badge-spot" : "badge-fund"}`}>
            {receipt.businessState}
          </span>
        </div>
      </div>
      <p className="receipt-order">
        Order <strong>{receipt.orderId}</strong>
        <a
          className="receipt-evidence-link"
          href="#receipt-evidence"
          onClick={() => setEvidenceOpen(true)}
        >
          Evidence
        </a>
      </p>
      <div className="receipt-change">
        <span className="receipt-change-label">What changed</span>
        <strong>{change}</strong>
        <span className="receipt-change-reason">{reason}</span>
      </div>
      <dl className="receipt-grid">
        {receiptRows(receipt).map(([key, value]) => (
          <div key={key} className="receipt-row">
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="receipt-next">
        {nextStep === undefined ? (
          <>Final state: no further event in this replay.</>
        ) : (
          <>
            Next event: <strong>{nextStep.title}</strong> · {clockLabel(nextStep.occurredAt)}
          </>
        )}
      </p>
      <details
        className="receipt-base-units"
        id="receipt-evidence"
        open={evidenceOpen}
        onToggle={(event) => setEvidenceOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary>Canonical base units and evidence</summary>
        <dl className="receipt-grid">
          {Object.entries(receipt).map(([key, value]) => (
            <div key={key} className="receipt-row">
              <dt>{key}</dt>
              <dd className="mono">{String(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="receipt-note">
          Integer base units are the reconciliation values; the canonical replay pack is{" "}
          <a href={EVIDENCE_PACK_URL}>evidence/g01/golden-run.json</a>.
        </p>
      </details>
    </div>
  );
}

function PortfolioPanel({
  snapshot,
  mode,
}: {
  snapshot: PortfolioSnapshot;
  mode: "g01" | "redemption";
}): JSX.Element {
  const reserved = parseBaseUnits(snapshot.reservedCashBase);
  return (
    <div className="panel portfolio">
      <div className="panel-head">
        <h2>Investor portfolio</h2>
        <span className="fixture-tag">
          {mode === "g01" ? "G01" : "G01 + redemption"} · {snapshot.investorId}
        </span>
      </div>
      <div className="cash-grid">
        <div className="cash-card">
          <span className="cash-label">Spendable cash</span>
          <strong className="cash-value">€{eur(snapshot.spendableCashBase)}</strong>
          <span className="cash-note">dEUR · 6 decimals</span>
        </div>
        <div className={`cash-card ${reserved > 0n ? "cash-card-pending" : ""}`}>
          <span className="cash-label">Pending (reserved)</span>
          <strong className="cash-value">€{eur(snapshot.reservedCashBase)}</strong>
          <span className="cash-note">
            {reserved > 0n ? "Awaiting authorized NAV" : "No cash reserved"}
          </span>
        </div>
      </div>
      <table className="holdings">
        <thead>
          <tr>
            <th>Asset</th>
            <th className="numeric">Balance</th>
            <th className="numeric">Mark</th>
            <th className="numeric">Marked value</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.holdings.map((holding) => {
            const reservedUnits = parseBaseUnits(holding.reservedBase);
            return (
              <tr key={holding.assetId}>
                <td>
                  <span className="asset-name">{holding.assetId}</span>
                  {holding.assetId === "tWETH" ? " · test wrapped ETH" : " · fictional bond fund unit"}
                  {reservedUnits > 0n ? (
                    <span className="reserved-units">
                      {" "}
                      · {tokenAmount(holding.reservedBase, "eFUND")} reserved for redemption
                    </span>
                  ) : null}
                </td>
                <td className="numeric mono">
                  {tokenAmount(holding.balanceBase, holding.assetId as "tWETH" | "eFUND")}
                </td>
                <td className="numeric mono">
                  €{eur(holding.markPriceBase)}
                </td>
                <td className="numeric mono">€{eur(holding.markedValueBase)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="portfolio-total">
        <span>Marked portfolio value at fixture marks</span>
        <strong>€{eur(snapshot.totalMarkedValueBase)}</strong>
      </div>
      {snapshot.pendingOrders.length > 0 ? (
        <ul className="pending-orders">
          {snapshot.pendingOrders.map((order) => (
            <li key={order.orderId}>
              <span className="pending-id">{order.orderId}</span>
              <span>
                {order.kind} · {pendingReason(order.status)}
              </span>
              {order.dealingDate === undefined ? null : (
                <span className="pending-date">dealing day {order.dealingDate}</span>
              )}
              {order.reservedCashBase === undefined ? null : (
                <span className="pending-detail">
                  reserved €{displayAmount(order.reservedCashBase, "dEUR")} · blocking rule:
                  authorized NAV required · next action: allocation at the authorized NAV
                  (fixture Fri 20 Nov 2026 · 17:00 UTC)
                </span>
              )}
              {order.reservedUnitsBase === undefined ? null : (
                <span className="pending-detail">
                  reserved {displayAmount(order.reservedUnitsBase, "eFUND")} eFUND · blocking
                  rule: next applicable NAV required · next action: burn and settle at the
                  next authorized NAV
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepDetail({ step }: { step: ReplayStep }): JSX.Element {
  return (
    <div className="panel step-detail">
      <div className="panel-head">
        <h2>Current event</h2>
        <span className="step-time">{clockLabel(step.occurredAt)}</span>
      </div>
      <h3>{step.title}</h3>
      <p className="step-description">{step.description}</p>
      <ul className="effects">
        {step.effects.map((effect) => (
          <li key={effect}>{effect}</li>
        ))}
      </ul>
      {step.journal.length > 0 ? (
        <table className="postings">
          <thead>
            <tr>
              <th>Account</th>
              <th>Asset</th>
              <th className="numeric">Movement</th>
            </tr>
          </thead>
          <tbody>
            {step.journal.flatMap((entry) =>
              entry.postings.map((posting, postingIndex) => {
                const amount = parseBaseUnits(posting.amountBase);
                const isNegative = amount < 0n;
                const formatted = displayAmount(
                  (isNegative ? -amount : amount).toString(),
                  posting.assetId as "dEUR" | "tWETH" | "eFUND",
                );
                return (
                  <tr key={`${entry.entryId}-${postingIndex}`}>
                    <td>{accountLabel(posting.accountKind, posting.accountId)}</td>
                    <td>{assetLabel(posting.assetId)}</td>
                    <td className={`numeric mono ${isNegative ? "debit" : "credit"}`}>
                      {isNegative ? "−" : "+"}
                      {formatted} {posting.assetId}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      ) : (
        <p className="no-postings">
          Observation event: no cash or asset movement. The state is recorded for the
          deterministic replay.
        </p>
      )}
    </div>
  );
}

function Controls({
  index,
  total,
  playing,
  onPrev,
  onNext,
  onReset,
  onToggle,
}: {
  index: number;
  total: number;
  playing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className="controls" role="group" aria-label="Replay controls">
      <button type="button" onClick={onReset} aria-label="Reset replay">
        Reset
      </button>
      <button type="button" onClick={onPrev} disabled={index === 0} aria-label="Previous event">
        ‹ Previous
      </button>
      <button type="button" className="primary" onClick={onToggle} aria-label={playing ? "Pause replay" : "Play replay"}>
        {playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      <button type="button" onClick={onNext} disabled={index >= total - 1} aria-label="Next event">
        Next ›
      </button>
      <span className="counter">
        {index + 1} / {total}
      </span>
    </div>
  );
}

function Timeline({
  steps,
  index,
  onSelect,
}: {
  steps: readonly ReplayStep[];
  index: number;
  onSelect: (nextIndex: number) => void;
}): JSX.Element {
  return (
    <ol className="timeline">
      {steps.map((step, stepIndex) => (
        <li
          key={step.id}
          className={stepIndex === index ? "timeline-item active" : stepIndex < index ? "timeline-item done" : "timeline-item"}
        >
          <button type="button" onClick={() => onSelect(stepIndex)}>
            <span className="timeline-time">{shortClock(step.occurredAt)}</span>
            <span className="timeline-title">{step.title}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function App(): JSX.Element {
  const initialLocation = typeof window === "undefined" ? null : parseReplayHash(window.location.hash);
  const [mode, setMode] = useState<ReplayMode>(
    initialLocation !== null && isReplayMode(initialLocation.mode) ? initialLocation.mode : "g01",
  );
  const steps = useMemo(
    () => (mode === "g01" ? g01Replay : [...g01Replay, ...redemptionReplay]),
    [mode],
  );
  const [index, setIndex] = useState(() =>
    clampReplayIndex(
      initialLocation?.index ?? 0,
      initialLocation?.mode === "redemption" ? g01Replay.length + redemptionReplay.length : g01Replay.length,
    ),
  );
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<"replay" | "live" | "policy" | "eligibility" | "economics" | "film">("replay");

  const currentStep = steps[index] ?? steps[steps.length - 1];

  // Addressable replay state: every control writes the same hash, and the browser
  // Back/Forward buttons and shared links restore the same mode and event.
  useEffect(() => {
    const hash = buildReplayHash(mode, clampReplayIndex(index, steps.length));
    if (window.location.hash !== hash) {
      window.history.replaceState(null, "", hash);
    }
  }, [mode, index, steps.length]);

  useEffect(() => {
    const onHashChange = (): void => {
      const location = parseReplayHash(window.location.hash);
      if (location === null) {
        return;
      }
      setPlaying(false);
      setMode(location.mode);
      const nextSteps = location.mode === "g01" ? g01Replay : [...g01Replay, ...redemptionReplay];
      setIndex(clampReplayIndex(location.index, nextSteps.length));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectMode = useCallback(
    (nextMode: ReplayMode) => {
      setMode(nextMode);
      setPlaying(false);
      // Switching lifecycle starts the story at the seed; the outcome stays one link away.
      setIndex(0);
    },
    [],
  );

  const startReplay = useCallback(() => {
    setPlaying(false);
    setIndex(0);
  }, []);

  const viewOutcome = useCallback(() => {
    setPlaying(false);
    setIndex(steps.length - 1);
  }, [steps.length]);

  const next = useCallback(() => {
    setIndex((current) => Math.min(current + 1, steps.length - 1));
  }, [steps.length]);

  const previous = useCallback(() => {
    setIndex((current) => Math.max(current - 1, 0));
  }, []);

  const reset = useCallback(() => {
    setPlaying(false);
    setIndex(0);
  }, []);

  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= steps.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1800);
    return () => window.clearInterval(timer);
  }, [playing, steps.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        previous();
      }
      if (event.key === " ") {
        event.preventDefault();
        setPlaying((current) => !current);
      }
      if (event.key === "Home") {
        event.preventDefault();
        startReplay();
      }
      if (event.key === "End") {
        event.preventDefault();
        viewOutcome();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [next, previous, startReplay, viewOutcome]);

  if (currentStep === undefined) {
    return <main className="app">No replay steps available.</main>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">€</div>
          <div>
            <h1>EuroRollup Settlement Lab</h1>
            <p>Euro settlement sandbox for crypto trades and tokenized fund orders</p>
          </div>
        </div>
        <div className="badges">
          <span className="badge badge-warn">Synthetic data</span>
          <span className="badge">Recorded replay</span>
          <span className="badge badge-clock">Fixture clock</span>
          <a className="badge badge-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </header>

      <nav className="view-switch" aria-label="View">
        <button type="button" className={view === "replay" ? "active" : ""} onClick={() => setView("replay")}>
          Recorded replay
        </button>
        <button type="button" className={view === "live" ? "active" : ""} onClick={() => setView("live")}>
          Local API lab
        </button>
        <button
          type="button"
          className={view === "policy" ? "active" : ""}
          onClick={() => setView("policy")}
        >
          AI Policy Lab
        </button>
        <button
          type="button"
          className={view === "eligibility" ? "active" : ""}
          onClick={() => setView("eligibility")}
        >
          Eligibility &amp; sponsorship
        </button>
        <button
          type="button"
          className={view === "economics" ? "active" : ""}
          onClick={() => setView("economics")}
        >
          Economics &amp; operations
        </button>
        <button type="button" className={view === "film" ? "active" : ""} onClick={() => setView("film")}>
          Release film
        </button>
      </nav>

      {view === "live" ? (
        <LiveLab />
      ) : view === "policy" ? (
        <PolicyLabView />
      ) : view === "eligibility" ? (
        <EligibilityView />
      ) : view === "economics" ? (
        <EconomicsView />
      ) : view === "film" ? (
        <ReleaseFilmView />
      ) : (
        <>
      <main className="layout">
        <section className="column">
          <PortfolioPanel snapshot={currentStep.snapshot} mode={mode} />
          <StepDetail step={currentStep} />
          {currentStep.receipt === undefined ? null : (
            <ReceiptCard receipt={currentStep.receipt} nextStep={steps[index + 1]} />
          )}
        </section>

        <aside className="column">
          <div className="panel replay">
            <div className="panel-head">
              <h2>Recorded settlement replay</h2>
              <div className="replay-head-meta">
                <span className="badge badge-source">Fixture replay</span>
                <span className="fixture-tag">
                  {fixtureInfo.fixtureId} · {fixtureInfo.calendarId}
                </span>
              </div>
            </div>
            <div className="mode-switch" role="tablist" aria-label="Lifecycle">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "g01"}
                className={mode === "g01" ? "active" : ""}
                onClick={() => selectMode("g01")}
              >
                G01 lifecycle
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "redemption"}
                className={mode === "redemption" ? "active" : ""}
                onClick={() => selectMode("redemption")}
              >
                G01 + redemption
              </button>
            </div>
            <div className="replay-jumps">
              <button
                type="button"
                className="jump-button"
                onClick={startReplay}
                aria-label="Start replay at the synthetic account seed"
              >
                Start replay
              </button>
              <button
                type="button"
                className="jump-button"
                onClick={viewOutcome}
                aria-label="View the final outcome of this replay"
              >
                View outcome
              </button>
              <a className="jump-link" href={buildReplayHash(mode, 0)} aria-label="Direct link to the replay seed">
                Link to seed
              </a>
            </div>
            <Controls
              index={index}
              total={steps.length}
              playing={playing}
              onPrev={previous}
              onNext={next}
              onReset={reset}
              onToggle={() => setPlaying((current) => !current)}
            />
            <Timeline steps={steps} index={index} onSelect={setIndex} />
          </div>

          <div className="panel notes">
            <h2>What this page proves</h2>
            <ul>
              <li>
                The portfolio is computed locally from the frozen fixtures with the same
                pure dealing engine the CLI evidence runner uses.
              </li>
              <li>
                The EUR 300 fund subscription is shown once as pending cash and replaced by
                3.125000 eFUND units only at the authorized NAV of 96.00 EUR.
              </li>
              <li>
                The separate redemption case reserves one unit, then burns and pays it at the
                next applicable NAV of 98.00 EUR.
              </li>
            </ul>
            <div className="command">
              <code>pnpm scenario:golden</code>
              <span>writes the reproducible evidence pack</span>
            </div>
            <div className="command">
              <code>pnpm verify</code>
              <span>checks inputs, digests and a fresh replay</span>
            </div>
            <p className="notes-small">
              Fixture {fixtureInfo.fixtureId} v{fixtureInfo.fixtureVersion} · calendar{" "}
              {fixtureInfo.calendarId} v{fixtureInfo.calendarVersion}. Model output and
              deterministic results are labelled separately; this page shows computed results
              only.
            </p>
          </div>
        </aside>
      </main>

      <footer className="footer">
        <p>
          {fixtureInfo.description} Redemption case: {fixtureInfo.redemptionDescription}
        </p>
        <p>
          Next step: settlement core and partner API (GitHub issue S02). Source, fixtures and
          evidence:{" "}
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
            github.com/SergeyGer/eurorollup-settlement-lab
          </a>
          .
        </p>
      </footer>
        </>
      )}
    </div>
  );
}
