/**
 * Row access for quotes, orders, NAV observations and outbox tasks.
 *
 * All writes are explicit so a route or worker step can decide the transaction
 * boundary; amounts and timestamps stay decimal strings.
 */
import type { Database } from "./db.js";

export interface QuoteRow {
  readonly quote_id: string;
  readonly kind: string;
  readonly account_id: string;
  readonly asset_id: string;
  readonly side: string;
  readonly amount_base: string;
  readonly price_base: string | null;
  readonly price_as_of: string | null;
  readonly expires_at: string;
  readonly charge_ceiling_base: string;
  readonly indicative_nav_base: string | null;
  readonly dealing_terms_json: string | null;
  readonly created_at: string;
}

export interface OrderRow {
  readonly order_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly quote_id: string;
  readonly account_id: string;
  readonly kind: string;
  readonly asset_id: string;
  readonly side: string;
  readonly amount_base: string;
  readonly business_state: string;
  readonly chain_state: string;
  readonly reason_code: string | null;
  readonly policy_epoch: string;
  readonly trace_id: string;
  readonly dealing_date: string | null;
  readonly receipt_json: string | null;
  readonly movements_json: string;
  readonly detail_json: string | null;
  readonly decline_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface OrderUpdate {
  readonly business_state?: string;
  readonly chain_state?: string;
  readonly reason_code?: string | null;
  readonly dealing_date?: string | null;
  readonly receipt_json?: string | null;
  readonly movements_json?: string;
  readonly detail_json?: string | null;
  readonly decline_json?: string | null;
  readonly updated_at?: string;
}

export interface NavRow {
  readonly asset_id: string;
  readonly valuation_date: string;
  readonly nav_base: string;
  readonly source_time: string;
  readonly revision: number;
  readonly signer: string;
  readonly observed_at: string;
}

export interface InsertOrderInput {
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly quoteId: string;
  readonly accountId: string;
  readonly kind: string;
  readonly assetId: string;
  readonly side: string;
  readonly amountBase: string;
  readonly businessState: string;
  readonly chainState: string;
  readonly policyEpoch: string;
  readonly traceId: string;
  readonly createdAt: string;
}

export function insertQuote(db: Database, row: QuoteRow): void {
  db.prepare(
    `INSERT INTO quotes (quote_id, kind, account_id, asset_id, side, amount_base, price_base, price_as_of, expires_at, charge_ceiling_base, indicative_nav_base, dealing_terms_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.quote_id,
    row.kind,
    row.account_id,
    row.asset_id,
    row.side,
    row.amount_base,
    row.price_base,
    row.price_as_of,
    row.expires_at,
    row.charge_ceiling_base,
    row.indicative_nav_base,
    row.dealing_terms_json,
    row.created_at,
  );
}

export function getQuoteRow(db: Database, quoteId: string): QuoteRow | null {
  const row = db
    .prepare(
      "SELECT quote_id, kind, account_id, asset_id, side, amount_base, price_base, price_as_of, expires_at, charge_ceiling_base, indicative_nav_base, dealing_terms_json, created_at FROM quotes WHERE quote_id = ?",
    )
    .get(quoteId) as unknown as QuoteRow | undefined;
  return row ?? null;
}

export function insertOrder(db: Database, input: InsertOrderInput): void {
  db.prepare(
    `INSERT INTO orders (order_id, idempotency_key, request_hash, quote_id, account_id, kind, asset_id, side, amount_base, business_state, chain_state, reason_code, policy_epoch, trace_id, dealing_date, receipt_json, movements_json, detail_json, decline_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, '[]', NULL, NULL, ?, ?)`,
  ).run(
    input.orderId,
    input.idempotencyKey,
    input.requestHash,
    input.quoteId,
    input.accountId,
    input.kind,
    input.assetId,
    input.side,
    input.amountBase,
    input.businessState,
    input.chainState,
    input.policyEpoch,
    input.traceId,
    input.createdAt,
    input.createdAt,
  );
}

const ORDER_COLUMNS =
  "order_id, idempotency_key, request_hash, quote_id, account_id, kind, asset_id, side, amount_base, business_state, chain_state, reason_code, policy_epoch, trace_id, dealing_date, receipt_json, movements_json, detail_json, decline_json, created_at, updated_at";

export function getOrderRow(db: Database, orderId: string): OrderRow | null {
  const row = db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_id = ?`)
    .get(orderId) as unknown as OrderRow | undefined;
  return row ?? null;
}

export function getOrderRowByIdempotencyKey(
  db: Database,
  idempotencyKey: string,
): OrderRow | null {
  const row = db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE idempotency_key = ?`)
    .get(idempotencyKey) as unknown as OrderRow | undefined;
  return row ?? null;
}

export function listOrderRows(db: Database, accountId: string): OrderRow[] {
  return db
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE account_id = ? ORDER BY created_at ASC, order_id ASC`,
    )
    .all(accountId) as unknown as OrderRow[];
}

export function listOrdersAwaitingDate(db: Database, dealingDate: string): OrderRow[] {
  return db
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE business_state = 'AWAITING_NAV' AND dealing_date = ? ORDER BY created_at ASC, order_id ASC`,
    )
    .all(dealingDate) as unknown as OrderRow[];
}

export function countOrders(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM orders").get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

export function updateOrderRow(db: Database, orderId: string, update: OrderUpdate): void {
  const assignments: string[] = [];
  const values: Array<string | null> = [];
  const mapping: Array<[keyof OrderUpdate, string]> = [
    ["business_state", "business_state"],
    ["chain_state", "chain_state"],
    ["reason_code", "reason_code"],
    ["dealing_date", "dealing_date"],
    ["receipt_json", "receipt_json"],
    ["movements_json", "movements_json"],
    ["detail_json", "detail_json"],
    ["decline_json", "decline_json"],
    ["updated_at", "updated_at"],
  ];
  for (const [key, column] of mapping) {
    const value = update[key];
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (assignments.length === 0) {
    return;
  }
  db.prepare(`UPDATE orders SET ${assignments.join(", ")} WHERE order_id = ?`).run(
    ...values,
    orderId,
  );
}

export function getNavRow(
  db: Database,
  assetId: string,
  valuationDate: string,
): NavRow | null {
  const row = db
    .prepare(
      "SELECT asset_id, valuation_date, nav_base, source_time, revision, signer, observed_at FROM navs WHERE asset_id = ? AND valuation_date = ?",
    )
    .get(assetId, valuationDate) as unknown as NavRow | undefined;
  return row ?? null;
}

export function listNavRows(db: Database): NavRow[] {
  return db
    .prepare(
      "SELECT asset_id, valuation_date, nav_base, source_time, revision, signer, observed_at FROM navs ORDER BY valuation_date ASC",
    )
    .all() as unknown as NavRow[];
}

export function upsertNav(db: Database, row: NavRow): void {
  db.prepare(
    `INSERT INTO navs (asset_id, valuation_date, nav_base, source_time, revision, signer, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, valuation_date) DO UPDATE SET
       nav_base = excluded.nav_base,
       source_time = excluded.source_time,
       revision = excluded.revision,
       signer = excluded.signer,
       observed_at = excluded.observed_at`,
  ).run(
    row.asset_id,
    row.valuation_date,
    row.nav_base,
    row.source_time,
    row.revision,
    row.signer,
    row.observed_at,
  );
}

export function markOutboxDone(db: Database, outboxId: number): void {
  db.prepare("UPDATE outbox SET status = 'DONE' WHERE id = ?").run(outboxId);
}

export function retryOutboxRow(db: Database, outboxId: number, error: string): void {
  db.prepare(
    "UPDATE outbox SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= 3 THEN 'FAILED' ELSE 'PENDING' END WHERE id = ?",
  ).run(error, outboxId);
}


// ---------------------------------------------------------------------------
// Policy Lab scenarios and scenario runs
// ---------------------------------------------------------------------------

export interface ScenarioRow {
  readonly scenario_id: string;
  readonly session_id: string;
  readonly fixture_id: string;
  readonly mode: string;
  readonly origin: string;
  readonly baseline_policy_json: string;
  readonly baseline_policy_hash: string;
  readonly fixture_hash: string;
  readonly policy_lab_version: string;
  readonly current_revision: number;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ScenarioRevisionRow {
  readonly scenario_id: string;
  readonly revision: number;
  readonly draft_json: string;
  readonly draft_digest: string;
  readonly confirmation_digest: string;
  readonly created_at: string;
}

export interface ScenarioRunRow {
  readonly run_id: string;
  readonly scenario_id: string;
  readonly session_id: string;
  readonly revision: number;
  readonly confirmation_digest: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly evidence_json: string | null;
  readonly error_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface InsertScenarioInput {
  readonly scenarioId: string;
  readonly sessionId: string;
  readonly fixtureId: string;
  readonly mode: string;
  readonly origin: string;
  readonly baselinePolicyJson: string;
  readonly baselinePolicyHash: string;
  readonly fixtureHash: string;
  readonly policyLabVersion: string;
  readonly currentRevision: number;
  readonly status: string;
  readonly createdAt: string;
}

export function insertScenario(db: Database, input: InsertScenarioInput): void {
  db.prepare(
    `INSERT INTO scenarios (scenario_id, session_id, fixture_id, mode, origin, baseline_policy_json, baseline_policy_hash, fixture_hash, policy_lab_version, current_revision, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.scenarioId,
    input.sessionId,
    input.fixtureId,
    input.mode,
    input.origin,
    input.baselinePolicyJson,
    input.baselinePolicyHash,
    input.fixtureHash,
    input.policyLabVersion,
    input.currentRevision,
    input.status,
    input.createdAt,
    input.createdAt,
  );
}

export function getScenarioRow(db: Database, scenarioId: string): ScenarioRow | null {
  const row = db
    .prepare(
      "SELECT scenario_id, session_id, fixture_id, mode, origin, baseline_policy_json, baseline_policy_hash, fixture_hash, policy_lab_version, current_revision, status, created_at, updated_at FROM scenarios WHERE scenario_id = ?",
    )
    .get(scenarioId) as unknown as ScenarioRow | undefined;
  return row ?? null;
}

export function updateScenarioRevision(
  db: Database,
  scenarioId: string,
  revision: number,
  status: string,
  origin: string,
  updatedAt: string,
): void {
  db.prepare(
    "UPDATE scenarios SET current_revision = ?, status = ?, origin = ?, updated_at = ? WHERE scenario_id = ?",
  ).run(revision, status, origin, updatedAt, scenarioId);
}

export function insertScenarioRevision(
  db: Database,
  row: ScenarioRevisionRow,
): void {
  db.prepare(
    "INSERT INTO scenario_revisions (scenario_id, revision, draft_json, draft_digest, confirmation_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    row.scenario_id,
    row.revision,
    row.draft_json,
    row.draft_digest,
    row.confirmation_digest,
    row.created_at,
  );
}

export function getScenarioRevisionRow(
  db: Database,
  scenarioId: string,
  revision: number,
): ScenarioRevisionRow | null {
  const row = db
    .prepare(
      "SELECT scenario_id, revision, draft_json, draft_digest, confirmation_digest, created_at FROM scenario_revisions WHERE scenario_id = ? AND revision = ?",
    )
    .get(scenarioId, revision) as unknown as ScenarioRevisionRow | undefined;
  return row ?? null;
}

export interface InsertScenarioRunInput {
  readonly runId: string;
  readonly scenarioId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly confirmationDigest: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: string;
  readonly createdAt: string;
}

export function insertScenarioRun(db: Database, input: InsertScenarioRunInput): void {
  db.prepare(
    `INSERT INTO scenario_runs (run_id, scenario_id, session_id, revision, confirmation_digest, idempotency_key, request_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.scenarioId,
    input.sessionId,
    input.revision,
    input.confirmationDigest,
    input.idempotencyKey,
    input.requestHash,
    input.status,
    input.createdAt,
    input.createdAt,
  );
}

const RUN_COLUMNS =
  "run_id, scenario_id, session_id, revision, confirmation_digest, idempotency_key, request_hash, status, result_json, evidence_json, error_json, created_at, updated_at";

export function getScenarioRunRow(db: Database, runId: string): ScenarioRunRow | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM scenario_runs WHERE run_id = ?`)
    .get(runId) as unknown as ScenarioRunRow | undefined;
  return row ?? null;
}

export function getScenarioRunRowByIdempotencyKey(
  db: Database,
  idempotencyKey: string,
): ScenarioRunRow | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM scenario_runs WHERE idempotency_key = ?`)
    .get(idempotencyKey) as unknown as ScenarioRunRow | undefined;
  return row ?? null;
}

export function updateScenarioRun(
  db: Database,
  runId: string,
  update: {
    readonly status?: string;
    readonly resultJson?: string | null;
    readonly evidenceJson?: string | null;
    readonly errorJson?: string | null;
    readonly updatedAt?: string;
  },
): void {
  const assignments: string[] = [];
  const values: Array<string | null> = [];
  const mapping: Array<[keyof typeof update, string]> = [
    ["status", "status"],
    ["resultJson", "result_json"],
    ["evidenceJson", "evidence_json"],
    ["errorJson", "error_json"],
    ["updatedAt", "updated_at"],
  ];
  for (const [key, column] of mapping) {
    const value = update[key];
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (assignments.length === 0) {
    return;
  }
  db.prepare(`UPDATE scenario_runs SET ${assignments.join(", ")} WHERE run_id = ?`).run(
    ...values,
    runId,
  );
}
