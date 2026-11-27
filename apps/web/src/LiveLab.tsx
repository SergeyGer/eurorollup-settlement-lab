/**
 * Live local-API lab.
 *
 * The same typed SDK a distributor would use drives the local partner API: create
 * a quote, accept an order, advance the fixture clock, publish an authorized NAV
 * and watch the portfolio, receipts and order states update. No wallet and no
 * model key are involved in this mode.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatDisplayAmount,
  parseBaseUnits,
  parseDecimalToBase,
} from "@eurorollup/dealing";
import {
  PartnerApiError,
  SettlementApiClient,
  createIdempotencyKey,
  type HealthStatus,
  type Order,
  type Portfolio,
  type PortfolioSummary,
  type Quote,
} from "@eurorollup/sdk";

export const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:3000";

const client = new SettlementApiClient({ baseUrl: API_BASE_URL });
const issuerClient = new SettlementApiClient({
  baseUrl: API_BASE_URL,
  roleIdentity: "issuer-nav-signer",
});

function groupThousands(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

function eur(baseUnits: string): string {
  return groupThousands(formatDisplayAmount(parseBaseUnits(baseUnits), 6, 2));
}

function assetAmount(baseUnits: string, decimals: number): string {
  return groupThousands(formatDisplayAmount(parseBaseUnits(baseUnits), decimals, decimals === 18 ? 6 : 6));
}

function shortOrderId(orderId: string): string {
  return orderId.length > 22 ? `${orderId.slice(0, 19)}…` : orderId;
}

function describeError(error: unknown): string {
  if (error instanceof PartnerApiError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type TicketTab = "spot" | "fund" | "redeem";

const CLOCK_PRESETS: ReadonlyArray<{ label: string; to: string }> = [
  { label: "Fri 15:59:59", to: "2026-11-20T15:59:59Z" },
  { label: "Fri 16:00:00", to: "2026-11-20T16:00:00Z" },
  { label: "Fri 17:01", to: "2026-11-20T17:01:00Z" },
  { label: "Fri 17:05", to: "2026-11-20T17:05:00Z" },
  { label: "Mon 17:01", to: "2026-11-23T17:01:00Z" },
];

const NAV_PRESETS: ReadonlyArray<{
  label: string;
  valuationDate: string;
  navBase: string;
  sourceTime: string;
}> = [
  { label: "NAV Fri 96.00", valuationDate: "2026-11-20", navBase: "96000000", sourceTime: "2026-11-20T17:00:00Z" },
  { label: "NAV Mon 98.00", valuationDate: "2026-11-23", navBase: "98000000", sourceTime: "2026-11-23T17:00:00Z" },
  { label: "NAV Mon 100.00", valuationDate: "2026-11-23", navBase: "100000000", sourceTime: "2026-11-23T17:00:00Z" },
];

function statusClass(state: string): string {
  if (state === "FILLED" || state === "ALLOCATED" || state === "REDEEMED") {
    return "state state-good";
  }
  if (state === "DECLINED" || state === "CANCELLED") {
    return "state state-bad";
  }
  return "state state-pending";
}

function ReceiptDetails({ order }: { order: Order }): JSX.Element {
  if (order.receipt !== null) {
    return (
      <dl className="receipt-grid">
        {Object.entries(order.receipt).map(([key, value]) => (
          <div key={key} className="receipt-row">
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (order.decline !== null) {
    return (
      <p className="ticket-note warning">
        Declined with {order.decline.code}: {order.decline.message}
      </p>
    );
  }
  return (
    <p className="ticket-note">
      {order.businessState}
      {order.reasonCode === null ? "" : ` · ${order.reasonCode}`}
      {order.dealingTerms === null ? "" : ` · dealing day ${order.dealingTerms.assignedDealingDate}`}
      {" · waiting for the worker or an authorized NAV"}
    </p>
  );
}

export function LiveLab(): JSX.Element {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [accounts, setAccounts] = useState<PortfolioSummary[]>([]);
  const [accountId, setAccountId] = useState("investor-ada");
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastQuote, setLastQuote] = useState<Quote | null>(null);
  const [tab, setTab] = useState<TicketTab>("spot");
  const [spotAmount, setSpotAmount] = useState("200.00");
  const [fundAmount, setFundAmount] = useState("300.00");
  const [redeemUnits, setRedeemUnits] = useState("1.000000");

  const refresh = useCallback(async (): Promise<void> => {
    const [healthResult, accountsResult, portfolioResult, ordersResult] = await Promise.all([
      client.getHealth(),
      client.listPortfolios(),
      client.getPortfolio(accountId),
      client.listOrders(accountId),
    ]);
    setHealth(healthResult);
    setAccounts(accountsResult);
    setPortfolio(portfolioResult);
    setOrders(ordersResult);
    setSelectedOrder((current) => {
      if (current === null) {
        return ordersResult[ordersResult.length - 1] ?? null;
      }
      return ordersResult.find((order) => order.orderId === current.orderId) ?? current;
    });
  }, [accountId]);

  const refreshSafely = useCallback(async (): Promise<void> => {
    try {
      await refresh();
      setConnected(true);
    } catch (refreshError) {
      setConnected(false);
      setError(describeError(refreshError));
    }
  }, [refresh]);

  useEffect(() => {
    void refreshSafely();
    const timer = window.setInterval(() => {
      void refreshSafely();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshSafely]);

  const waitForOrder = useCallback(
    async (orderId: string, done: (order: Order) => boolean): Promise<Order> => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const order = await client.getOrder(orderId);
        if (done(order)) {
          return order;
        }
        await sleep(50);
      }
      throw new Error(`Order ${orderId} did not settle in time`);
    },
    [],
  );

  const run = useCallback(
    async (label: string, work: () => Promise<void>): Promise<void> => {
      setBusy(label);
      setError(null);
      try {
        await work();
      } catch (actionError) {
        setError(describeError(actionError));
      } finally {
        setBusy(null);
        await refreshSafely();
      }
    },
    [refreshSafely],
  );

  const submit = useCallback(
    async (assetId: "tWETH" | "eFUND", side: "BUY" | "SUBSCRIBE" | "REDEEM", amountBase: string): Promise<void> => {
      const quote = await client.createQuote({ accountId, assetId, side, amountBase });
      setLastQuote(quote);
      const placed = await client.placeOrder({ quoteId: quote.quoteId, accountId }, createIdempotencyKey());
      const order = await waitForOrder(placed.orderId, (candidate) =>
        candidate.businessState === "FILLED" ||
        candidate.businessState === "ALLOCATED" ||
        candidate.businessState === "REDEEMED" ||
        candidate.businessState === "AWAITING_NAV" ||
        candidate.businessState === "DECLINED",
      );
      setSelectedOrder(order);
      if (order.businessState === "DECLINED") {
        throw new PartnerApiError(order.decline?.message ?? "Order declined", {
          status: 422,
          code: order.decline?.code ?? "DECLINED",
        });
      }
    },
    [accountId, waitForOrder],
  );

  const buySpot = useCallback(async (): Promise<void> => {
    const amountBase = parseDecimalToBase(spotAmount, 6).toString();
    await run("spot", async () => {
      await submit("tWETH", "BUY", amountBase);
    });
  }, [run, spotAmount, submit]);

  const subscribeFund = useCallback(async (): Promise<void> => {
    const amountBase = parseDecimalToBase(fundAmount, 6).toString();
    await run("fund", async () => {
      await submit("eFUND", "SUBSCRIBE", amountBase);
    });
  }, [fundAmount, run, submit]);

  const redeemFund = useCallback(async (): Promise<void> => {
    const unitsBase = parseDecimalToBase(redeemUnits, 6).toString();
    await run("redeem", async () => {
      await submit("eFUND", "REDEEM", unitsBase);
    });
  }, [redeemUnits, run, submit]);

  const cancel = useCallback(
    async (orderId: string): Promise<void> => {
      await run("cancel", async () => {
        const cancelled = await client.cancelOrder(orderId, accountId);
        setSelectedOrder(cancelled);
      });
    },
    [accountId, run],
  );

  const advance = useCallback(
    async (to: string): Promise<void> => {
      await run("clock", async () => {
        await client.advanceClock(to);
      });
    },
    [run],
  );

  const publishNav = useCallback(
    async (preset: (typeof NAV_PRESETS)[number]): Promise<void> => {
      await run("nav", async () => {
        await issuerClient.publishNav({
          assetId: "eFUND",
          valuationDate: preset.valuationDate,
          navBase: preset.navBase,
          sourceTime: preset.sourceTime,
          revision: 1,
        });
      });
    },
    [run],
  );

  const reset = useCallback(async (): Promise<void> => {
    await run("reset", async () => {
      await client.resetDemo();
      setLastQuote(null);
      setSelectedOrder(null);
    });
  }, [run]);

  const currentAccount = useMemo(
    () => accounts.find((account) => account.accountId === accountId),
    [accountId, accounts],
  );

  const canCancel = (order: Order): boolean =>
    (order.kind === "FUND_SUBSCRIPTION" || order.kind === "FUND_REDEMPTION") &&
    (order.businessState === "AWAITING_NAV" || order.businessState === "RESERVED");

  return (
    <section className="live">
      <div className={`live-banner ${connected === false ? "offline" : connected ? "online" : ""}`}>
        <span className="live-dot" aria-hidden="true" />
        {connected === false ? (
          <>
            Local API is not reachable at <code>{API_BASE_URL}</code>. Start it with <code>pnpm api</code>{" "}
            and keep this page open.
          </>
        ) : (
          <>
            Local API connected at <code>{API_BASE_URL}</code>
            {health === null ? "" : ` · fixture clock ${health.clock} · ${health.calendarId} · policy v${health.policyVersion} · events ${health.eventCount}`}
          </>
        )}
      </div>

      {error === null ? null : (
        <div className="live-error" role="alert">
          <strong>Request failed.</strong> {error}
        </div>
      )}

      <div className="layout">
        <section className="column">
          <div className="panel portfolio">
            <div className="panel-head">
              <h2>Live portfolio</h2>
              <span className="fixture-tag">
                {portfolio?.dataMode ?? "local-fixture"} · {portfolio?.asOf ?? "waiting"}
              </span>
            </div>
            <label className="select-row">
              <span>Account</span>
              <select
                value={accountId}
                onChange={(event) => {
                  setAccountId(event.target.value);
                  setSelectedOrder(null);
                }}
              >
                {accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.displayName} · {account.persona}
                  </option>
                ))}
              </select>
            </label>
            {portfolio === null ? (
              <p className="ticket-note">Waiting for the local API…</p>
            ) : (
              <>
                <div className="cash-grid">
                  <div className="cash-card">
                    <span className="cash-label">Spendable cash</span>
                    <strong className="cash-value">€{eur(portfolio.balances.dEUR.availableBase)}</strong>
                    <span className="cash-note">dEUR · 6 decimals</span>
                  </div>
                  <div className={`cash-card ${parseBaseUnits(portfolio.balances.dEUR.reservedBase) > 0n ? "cash-card-pending" : ""}`}>
                    <span className="cash-label">Pending (reserved)</span>
                    <strong className="cash-value">€{eur(portfolio.balances.dEUR.reservedBase)}</strong>
                    <span className="cash-note">
                      {portfolio.pendingOrders.length === 0
                        ? "No pending fund orders"
                        : `${portfolio.pendingOrders.length} pending order(s)`}
                    </span>
                  </div>
                </div>
                <table className="holdings">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th className="numeric">Available</th>
                      <th className="numeric">Reserved</th>
                      <th className="numeric">Mark</th>
                      <th className="numeric">Marked value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="asset-name">tWETH</td>
                      <td className="numeric mono">{assetAmount(portfolio.balances.tWETH.availableBase, 18)}</td>
                      <td className="numeric mono">{assetAmount(portfolio.balances.tWETH.reservedBase, 18)}</td>
                      <td className="numeric mono">
                        €{eur(portfolio.marks.find((mark) => mark.assetId === "tWETH")?.priceBase ?? "0")}
                      </td>
                      <td className="numeric mono">
                        €{eur(
                          String(
                            BigInt(portfolio.balances.tWETH.availableBase) *
                              BigInt(portfolio.marks.find((mark) => mark.assetId === "tWETH")?.priceBase ?? "0") /
                              10n ** 18n,
                          ),
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td className="asset-name">eFUND</td>
                      <td className="numeric mono">{assetAmount(portfolio.balances.eFUND.availableBase, 6)}</td>
                      <td className="numeric mono">{assetAmount(portfolio.balances.eFUND.reservedBase, 6)}</td>
                      <td className="numeric mono">
                        €{eur(portfolio.marks.find((mark) => mark.assetId === "eFUND")?.priceBase ?? "0")}
                      </td>
                      <td className="numeric mono">
                        €{eur(
                          String(
                            (BigInt(portfolio.balances.eFUND.availableBase) +
                              BigInt(portfolio.balances.eFUND.reservedBase)) *
                              BigInt(portfolio.marks.find((mark) => mark.assetId === "eFUND")?.priceBase ?? "0") /
                              10n ** 6n,
                          ),
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="portfolio-total">
                  <span>Marked portfolio value</span>
                  <strong>€{eur(portfolio.markedValueBase)}</strong>
                </div>
                {portfolio.pendingOrders.length === 0 ? null : (
                  <ul className="pending-orders">
                    {portfolio.pendingOrders.map((pending) => (
                      <li key={pending.orderId}>
                        <span className="pending-id">{pending.orderId}</span>
                        <span>
                          {pending.kind} · {pending.businessState}
                          {pending.reasonCode === null ? "" : ` · ${pending.reasonCode}`}
                        </span>
                        {pending.dealingDate === null ? null : (
                          <span className="pending-date">dealing day {pending.dealingDate}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="notes-small">
                  Marks: {portfolio.marks.map((mark) => `${mark.assetId} ${mark.priceBase} (${mark.source}${mark.stale ? ", stale" : ""})`).join(" · ")}
                  {" · "}block hash unavailable in fixture mode.
                </p>
              </>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Orders and receipts</h2>
              <span className="fixture-tag">{orders.length} order(s) for {currentAccount?.accountId ?? accountId}</span>
            </div>
            {orders.length === 0 ? (
              <p className="ticket-note">No orders yet. Use the ticket on the right.</p>
            ) : (
              <table className="holdings order-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Kind</th>
                    <th>State</th>
                    <th>Reason</th>
                    <th>Dealing day</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.orderId} className={selectedOrder?.orderId === order.orderId ? "selected" : ""}>
                      <td className="mono order-id" title={order.orderId}>{shortOrderId(order.orderId)}</td>
                      <td>{order.kind}</td>
                      <td>
                        <span className={statusClass(order.businessState)}>{order.businessState}</span>
                      </td>
                      <td className="mono">{order.reasonCode ?? "—"}</td>
                      <td className="mono">{order.dealingTerms?.assignedDealingDate ?? "—"}</td>
                      <td className="order-actions">
                        <button type="button" onClick={() => setSelectedOrder(order)}>
                          view
                        </button>
                        {canCancel(order) ? (
                          <button type="button" onClick={() => void cancel(order.orderId)} disabled={busy !== null}>
                            cancel
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {selectedOrder === null ? null : (
              <div className="selected-order">
                <h3>Selected order</h3>
                <p className="ticket-note">
                  {selectedOrder.orderId} · {selectedOrder.kind} · {selectedOrder.businessState} · chain{" "}
                  {selectedOrder.chainState} · trace {selectedOrder.traceId}
                </p>
                <ReceiptDetails order={selectedOrder} />
                {selectedOrder.moneyMovements.length === 0 ? null : (
                  <table className="postings">
                    <thead>
                      <tr>
                        <th>Entry</th>
                        <th>Account</th>
                        <th>Asset</th>
                        <th className="numeric">Movement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedOrder.moneyMovements.flatMap((movement) =>
                        movement.postings.map((posting, postingIndex) => (
                          <tr key={`${movement.entryId}-${postingIndex}`}>
                            <td className="mono">{movement.entryId}</td>
                            <td>{posting.accountKind} · {posting.accountId}</td>
                            <td>{posting.assetId}</td>
                            <td className="numeric mono">
                              {posting.amountBase.startsWith("-") ? "−" : "+"}
                              {assetAmount(posting.amountBase.replace("-", ""), posting.assetId === "tWETH" ? 18 : 6)} {posting.assetId}
                            </td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="column">
          <div className="panel">
            <div className="panel-head">
              <h2>Ticket</h2>
              <span className="fixture-tag">quotes then confirms through the API</span>
            </div>
            <div className="tabs" role="tablist" aria-label="Order ticket">
              <button type="button" role="tab" aria-selected={tab === "spot"} className={tab === "spot" ? "active" : ""} onClick={() => setTab("spot")}>
                Buy tWETH
              </button>
              <button type="button" role="tab" aria-selected={tab === "fund"} className={tab === "fund" ? "active" : ""} onClick={() => setTab("fund")}>
                Subscribe eFUND
              </button>
              <button type="button" role="tab" aria-selected={tab === "redeem"} className={tab === "redeem" ? "active" : ""} onClick={() => setTab("redeem")}>
                Redeem eFUND
              </button>
            </div>
            {tab === "spot" ? (
              <div className="ticket">
                <label>
                  <span>Cash amount (dEUR)</span>
                  <input value={spotAmount} onChange={(event) => setSpotAmount(event.target.value)} inputMode="decimal" />
                </label>
                <p className="ticket-note">
                  Fixture dealer price 2,000.00 EUR per tWETH, fixed charge 0.05 dEUR, quote lifetime 30 seconds.
                </p>
                <button type="button" className="primary" onClick={() => void buySpot()} disabled={busy !== null}>
                  {busy === "spot" ? "Buying…" : "Quote and buy"}
                </button>
              </div>
            ) : null}
            {tab === "fund" ? (
              <div className="ticket">
                <label>
                  <span>Cash amount (dEUR)</span>
                  <input value={fundAmount} onChange={(event) => setFundAmount(event.target.value)} inputMode="decimal" />
                </label>
                <p className="ticket-note">
                  Cash is reserved immediately. Units are issued only after an authorized NAV for the assigned dealing day.
                </p>
                <button type="button" className="primary" onClick={() => void subscribeFund()} disabled={busy !== null}>
                  {busy === "fund" ? "Subscribing…" : "Quote and subscribe"}
                </button>
              </div>
            ) : null}
            {tab === "redeem" ? (
              <div className="ticket">
                <label>
                  <span>eFUND units</span>
                  <input value={redeemUnits} onChange={(event) => setRedeemUnits(event.target.value)} inputMode="decimal" />
                </label>
                <p className="ticket-note">
                  Units are reserved, then burned and paid at the next applicable authorized NAV.
                </p>
                <button type="button" className="primary" onClick={() => void redeemFund()} disabled={busy !== null}>
                  {busy === "redeem" ? "Redeeming…" : "Quote and redeem"}
                </button>
              </div>
            ) : null}
            {lastQuote === null ? null : (
              <p className="notes-small">
                Last quote {lastQuote.quoteId} · expires {lastQuote.expiresAt}
                {lastQuote.dealingTerms === undefined
                  ? ""
                  : ` · indicative dealing day ${lastQuote.dealingTerms.assignedDealingDate} (cutoff ${lastQuote.dealingTerms.cutoffTimeUtc} UTC)`}
              </p>
            )}
          </div>

          <div className="panel dev-controls">
            <div className="panel-head">
              <h2>Fixture controls</h2>
              <span className="fixture-tag">local dev only</span>
            </div>
            <p className="notes-small">
              The API uses a deterministic fixture clock. Move it forward, publish the issuer NAV and watch
              the worker settle the pending orders.
            </p>
            <div className="dev-group">
              <span className="dev-label">Advance clock</span>
              <div className="dev-buttons">
                {CLOCK_PRESETS.map((preset) => (
                  <button key={preset.to} type="button" onClick={() => void advance(preset.to)} disabled={busy !== null}>
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="dev-group">
              <span className="dev-label">Publish authorized NAV (issuer identity)</span>
              <div className="dev-buttons">
                {NAV_PRESETS.map((preset) => (
                  <button key={preset.label} type="button" onClick={() => void publishNav(preset)} disabled={busy !== null}>
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="dev-group">
              <span className="dev-label">Reset</span>
              <div className="dev-buttons">
                <button type="button" onClick={() => void reset()} disabled={busy !== null}>
                  Reset demo state
                </button>
              </div>
            </div>
            <p className="notes-small">
              Fixture clock: {health?.clock ?? "—"} · outbox pending: {health?.pendingOutbox ?? "—"} · engine{" "}
              {health?.engineVersion ?? "—"}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
