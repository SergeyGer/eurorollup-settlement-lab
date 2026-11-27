/**
 * Browser cost experiment and observed bundle reconciliation.
 *
 * The default view shows the last observed bundle next to an editable scenario.
 * All arithmetic runs locally in the deterministic economics package; missing
 * inputs are displayed as "unavailable" rather than zero.
 */
import { useMemo, useState } from "react";
import { evaluateCostExperiment, type RateObservation } from "@eurorollup/economics";
import {
  costExperiment,
  formatEth,
  formatEurMicros,
  observedBundle,
  rateFixture,
} from "./data/economics";

const RATE: RateObservation = {
  pair: "EUR/ETH",
  rateEurPerEth: rateFixture.rateEurPerEth,
  rateMicrosPerEth: BigInt(rateFixture.rateMicrosPerEth),
  observedAt: rateFixture.observedAt,
  source: "demo-fixture",
  maxAgeSeconds: rateFixture.maxAgeSeconds,
};

interface ScenarioForm {
  dailyOrders: number;
  eligibleSponsorShareBps: number;
  daPriceWeiPerByte: string;
  batchUtilizationBps: number;
  investorChargeEurMicros: string;
  dailyBudgetEurMicros: string;
  rateAgeSeconds: number;
}

const DEFAULT_FORM: ScenarioForm = {
  dailyOrders: costExperiment.scenarioInputs.dailyOrders,
  eligibleSponsorShareBps: costExperiment.scenarioInputs.eligibleSponsorShareBps,
  daPriceWeiPerByte: String(costExperiment.scenarioInputs.daPriceWeiPerByte),
  batchUtilizationBps: costExperiment.scenarioInputs.batchUtilizationBps,
  investorChargeEurMicros: String(costExperiment.scenarioInputs.investorChargeEurMicros),
  dailyBudgetEurMicros: String(costExperiment.scenarioInputs.dailyBudgetEurMicros),
  rateAgeSeconds: 0,
};

export function EconomicsView(): JSX.Element {
  const [form, setForm] = useState<ScenarioForm>(DEFAULT_FORM);
  const result = useMemo(() => {
    const daPrice = form.daPriceWeiPerByte.trim() === "" ? null : BigInt(form.daPriceWeiPerByte);
    const budget = form.dailyBudgetEurMicros.trim() === "" ? null : BigInt(form.dailyBudgetEurMicros);
    return evaluateCostExperiment({
      dailyOrders: form.dailyOrders,
      eligibleSponsorShareBps: form.eligibleSponsorShareBps,
      rate: RATE,
      rateAgeSeconds: form.rateAgeSeconds,
      daPriceWeiPerByte: daPrice,
      batchUtilizationBps: form.batchUtilizationBps,
      perOrderExecutionGas: BigInt(costExperiment.observedDefaults.perOrderExecutionGas),
      l1DataBytesPerOrder: BigInt(costExperiment.scenarioInputs.l1DataBytesPerOrder),
      gasPriceWei: BigInt(costExperiment.observedDefaults.gasPriceWei),
      investorChargeEurMicros: BigInt(form.investorChargeEurMicros),
      dailyBudgetEurMicros: budget,
    });
  }, [form]);

  const update = <Key extends keyof ScenarioForm>(key: Key, value: ScenarioForm[Key]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const numberValue = (value: number, onChange: (value: number) => void): JSX.Element => (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );

  return (
    <main className="layout economics">
      <section className="column">
        <div className="panel">
          <div className="panel-head">
            <h2>Observed bundle</h2>
            <span className="badge badge-spot">measured</span>
          </div>
          <p className="receipt-note">
            One real two-operation sponsored ERC-4337 bundle from <code>pnpm a07:economics</code>. Fees are
            integer wei; unavailable components are listed instead of being replaced with zero.
          </p>
          <div className="cash-grid">
            <div className="cash-card">
              <span className="cash-label">Sponsor paid</span>
              <strong className="cash-value">{formatEth(observedBundle.bundle.sponsorPaidWei)} ETH</strong>
              <span className="cash-note">{observedBundle.bundle.sponsorPaidWei} wei</span>
            </div>
            <div className="cash-card">
              <span className="cash-label">Bundler revenue</span>
              <strong className="cash-value">{formatEth(observedBundle.bundle.bundlerRevenueWei)} ETH</strong>
              <span className="cash-note">beneficiary balance movement</span>
            </div>
            <div className="cash-card">
              <span className="cash-label">Investor charge</span>
              <strong className="cash-value">€{formatEurMicros(observedBundle.charges.investorChargeEurMicros)}</strong>
              <span className="cash-note">explicit 0.05 dEUR leg</span>
            </div>
            <div className="cash-card">
              <span className="cash-label">Sponsor contribution</span>
              <strong className="cash-value">€{formatEurMicros(observedBundle.charges.sponsorContributionEurMicros)}</strong>
              <span className="cash-note">charge − sponsor cost at the demo rate</span>
            </div>
          </div>
          <p className="receipt-note">
            Unavailable fee components: {observedBundle.unavailable.join(", ")}. Outer transaction{" "}
            <code>{observedBundle.bundle.outerTxHash.slice(0, 18)}…</code> status {observedBundle.bundle.outerStatus}.
          </p>
          <table className="postings">
            <thead>
              <tr>
                <th>Allocation bucket</th>
                <th>Operation</th>
                <th>Gas used</th>
                <th>Allocated wei</th>
              </tr>
            </thead>
            <tbody>
              {observedBundle.reconciliation.allocations.map((allocation) => (
                <tr key={`${allocation.bucket}-${allocation.opId ?? "residual"}`}>
                  <td>{allocation.bucket}</td>
                  <td>{allocation.opId ?? "—"}</td>
                  <td>{allocation.gasUsed}</td>
                  <td>{allocation.allocWei}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="receipt-note">
            Allocations plus residual reproduce the bundle total:{" "}
            <strong>{String(observedBundle.reconciliation.invariants.allocationsPlusResidualEqualsTotal)}</strong>.
          </p>
        </div>
      </section>

      <section className="column">
        <div className="panel">
          <div className="panel-head">
            <h2>Editable cost scenario</h2>
            <span className="badge">modeled</span>
          </div>
          <p className="receipt-note">
            Execution gas and gas price come from the observed bundle; DA price, utilization, order volume,
            fee and budget are explicit scenario inputs. Missing inputs show as unavailable.
          </p>
          <div className="receipt-grid">
            <label className="receipt-row">
              <dt>Daily orders</dt>
              <dd>{numberValue(form.dailyOrders, (value) => update("dailyOrders", value))}</dd>
            </label>
            <label className="receipt-row">
              <dt>Eligible sponsor share (bps)</dt>
              <dd>{numberValue(form.eligibleSponsorShareBps, (value) => update("eligibleSponsorShareBps", value))}</dd>
            </label>
            <label className="receipt-row">
              <dt>DA price (wei per byte, blank = unavailable)</dt>
              <dd>
                <input value={form.daPriceWeiPerByte} onChange={(event) => update("daPriceWeiPerByte", event.target.value)} />
              </dd>
            </label>
            <label className="receipt-row">
              <dt>Batch utilization (bps)</dt>
              <dd>{numberValue(form.batchUtilizationBps, (value) => update("batchUtilizationBps", value))}</dd>
            </label>
            <label className="receipt-row">
              <dt>Investor charge (micro-EUR)</dt>
              <dd>
                <input value={form.investorChargeEurMicros} onChange={(event) => update("investorChargeEurMicros", event.target.value)} />
              </dd>
            </label>
            <label className="receipt-row">
              <dt>Daily budget (micro-EUR, blank = unavailable)</dt>
              <dd>
                <input value={form.dailyBudgetEurMicros} onChange={(event) => update("dailyBudgetEurMicros", event.target.value)} />
              </dd>
            </label>
            <label className="receipt-row">
              <dt>Rate age (seconds)</dt>
              <dd>{numberValue(form.rateAgeSeconds, (value) => update("rateAgeSeconds", value))}</dd>
            </label>
          </div>
          <button
            type="button"
            className="badge badge-link"
            onClick={() => setForm(DEFAULT_FORM)}
          >
            Load observed defaults
          </button>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Scenario result</h2>
            <span className="badge badge-fund">{result.unavailable.length === 0 ? "complete" : "unavailable inputs"}</span>
          </div>
          <dl className="receipt-grid">
            <div className="receipt-row">
              <dt>Sponsor cost per order</dt>
              <dd>{result.perOrderSponsorCostWei === null ? "unavailable" : `${formatEth(result.perOrderSponsorCostWei.toString())} ETH`}</dd>
            </div>
            <div className="receipt-row">
              <dt>Sponsor contribution per order</dt>
              <dd>€{formatEurMicros(result.sponsorContributionPerOrderEurMicros === null ? null : result.sponsorContributionPerOrderEurMicros.toString())}</dd>
            </div>
            <div className="receipt-row">
              <dt>Eligible orders per day</dt>
              <dd>{result.eligibleOrdersPerDay}</dd>
            </div>
            <div className="receipt-row">
              <dt>Daily sponsorship need</dt>
              <dd>€{formatEurMicros(result.dailySponsorshipNeedEurMicros === null ? null : result.dailySponsorshipNeedEurMicros.toString())}</dd>
            </div>
            <div className="receipt-row">
              <dt>Budget remaining</dt>
              <dd>€{formatEurMicros(result.budgetRemainingEurMicros === null ? null : result.budgetRemainingEurMicros.toString())}</dd>
            </div>
            <div className="receipt-row">
              <dt>Budget exhausted</dt>
              <dd>{result.budgetExhausted ? "yes" : "no"}</dd>
            </div>
            <div className="receipt-row">
              <dt>First exhausting daily orders</dt>
              <dd>{result.firstExhaustingDailyOrders === null ? "not reached in the swept range" : result.firstExhaustingDailyOrders}</dd>
            </div>
            <div className="receipt-row">
              <dt>Break-even investor charge</dt>
              <dd>€{formatEurMicros(result.firstSustainableChargeEurMicros === null ? null : result.firstSustainableChargeEurMicros.toString())}</dd>
            </div>
          </dl>
          {result.unavailable.length > 0 ? (
            <p className="receipt-note">Unavailable: {result.unavailable.join(", ")}.</p>
          ) : null}
          {result.notes.length > 0 ? <p className="receipt-note">{result.notes.join(" ")}</p> : null}
          <p className="receipt-note">
            Scenario data mode: modeled from the observed execution cost. The demo EUR/ETH rate is a frozen
            fixture, not a live market rate.
          </p>
        </div>
      </section>
    </main>
  );
}
