/**
 * SQLite persistence for the local partner API.
 *
 * The event log is the source of truth; the journal, order rows and outbox are
 * projections that can be rebuilt or safely replayed. All timestamps come from
 * the fixture clock, so a demo run is reproducible from versioned inputs.
 *
 * The API requires Node.js 22.5+ for the built-in `node:sqlite` module.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalEntry, SettlementEvent } from "@eurorollup/dealing";
import { ENGINE_ACCOUNT_IDS, type ApiConfig } from "./config.js";

export type Database = DatabaseSync;

export interface AccountRow {
  readonly account_id: string;
  readonly display_name: string;
  readonly persona: string;
}

export interface PriceSourceState {
  readonly asOf: string | null;
  readonly staleSeconds: number;
  readonly unavailable: boolean;
}

export interface OutboxRow {
  readonly id: number;
  readonly task: string;
  readonly order_id: string;
  readonly payload_json: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly available_at: number;
  readonly last_error: string | null;
  readonly created_at: string;
}

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    now TEXT NOT NULL,
    previous TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    persona TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS quotes (
    quote_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    account_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    side TEXT NOT NULL,
    amount_base TEXT NOT NULL,
    price_base TEXT,
    price_as_of TEXT,
    expires_at TEXT NOT NULL,
    charge_ceiling_base TEXT NOT NULL,
    indicative_nav_base TEXT,
    dealing_terms_json TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    side TEXT NOT NULL,
    amount_base TEXT NOT NULL,
    business_state TEXT NOT NULL,
    chain_state TEXT NOT NULL,
    reason_code TEXT,
    policy_epoch TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    dealing_date TEXT,
    receipt_json TEXT,
    movements_json TEXT NOT NULL DEFAULT '[]',
    detail_json TEXT,
    decline_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(business_state)`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    order_id TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, available_at)`,
  `CREATE TABLE IF NOT EXISTS event_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    order_id TEXT,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS journal (
    entry_id TEXT PRIMARY KEY,
    order_id TEXT,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS navs (
    asset_id TEXT NOT NULL,
    valuation_date TEXT NOT NULL,
    nav_base TEXT NOT NULL,
    source_time TEXT NOT NULL,
    revision INTEGER NOT NULL,
    signer TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (asset_id, valuation_date)
  )`,
  `CREATE TABLE IF NOT EXISTS price_source (
    id TEXT PRIMARY KEY,
    as_of TEXT,
    stale_seconds INTEGER NOT NULL DEFAULT 0,
    unavailable INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS scenarios (
    scenario_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    fixture_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    origin TEXT NOT NULL,
    baseline_policy_json TEXT NOT NULL,
    baseline_policy_hash TEXT NOT NULL,
    fixture_hash TEXT NOT NULL,
    policy_lab_version TEXT NOT NULL,
    current_revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS scenario_revisions (
    scenario_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    draft_json TEXT NOT NULL,
    draft_digest TEXT NOT NULL,
    confirmation_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scenario_id, revision)
  )`,
  `CREATE TABLE IF NOT EXISTS scenario_runs (
    run_id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    confirmation_digest TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    evidence_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scenario_runs_scenario ON scenario_runs(scenario_id)`,
];

export function openDatabase(dbFile: string): Database {
  if (dbFile !== ":memory:") {
    mkdirSync(dirname(dbFile), { recursive: true });
  }
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
}

/** Runs a synchronous SQLite transaction. */
export function transaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw error;
  }
}

export function isSeeded(db: Database): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'initialized'").get() as
    | { value: string }
    | undefined;
  return row?.value === "true";
}

/** Inserts the deterministic genesis events that fund the synthetic accounts. */
export function genesisEvents(config: ApiConfig): SettlementEvent[] {
  const occurredAt = "2026-11-19T00:00:00Z";
  const events: SettlementEvent[] = [];
  config.seedInvestors.forEach((investor, index) => {
    events.push({
      type: "account.seeded",
      eventId: `GENESIS-EV-${(index + 1).toString().padStart(3, "0")}`,
      occurredAt,
      account: { kind: "investor", accountId: investor.accountId },
      assetId: "dEUR",
      amountBase: "1000000000",
    });
  });
  events.push({
    type: "account.seeded",
    eventId: `GENESIS-EV-${(events.length + 1).toString().padStart(3, "0")}`,
    occurredAt,
    account: { kind: "dealer", accountId: ENGINE_ACCOUNT_IDS.dealer },
    assetId: "tWETH",
    amountBase: "100000000000000000000",
  });
  return events;
}

export function seedDatabase(db: Database, config: ApiConfig): void {
  transaction(db, () => {
    for (const employee of config.seedInvestors) {
      db.prepare("INSERT INTO accounts (account_id, display_name, persona) VALUES (?, ?, ?)").run(
        employee.accountId,
        employee.displayName,
        employee.persona,
      );
    }
    db.prepare("INSERT INTO clock (id, now, previous) VALUES (1, ?, NULL)").run(
      config.fixtureClockStart,
    );
    db.prepare(
      "INSERT INTO price_source (id, as_of, stale_seconds, unavailable) VALUES (?, NULL, 0, 0)",
    ).run("dealer-tWETH-fixture");
    for (const event of genesisEvents(config)) {
      insertEvent(db, event, null);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('initialized', 'true')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', '1.0.0')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('serviceVersion', ?)").run(
      config.serviceVersion,
    );
  });
}

export function ensureSeed(db: Database, config: ApiConfig): void {
  if (!isSeeded(db)) {
    seedDatabase(db, config);
  }
}

const DATA_TABLES = [
  "scenario_runs",
  "scenario_revisions",
  "scenarios",
  "journal",
  "event_log",
  "outbox",
  "orders",
  "quotes",
  "navs",
  "price_source",
  "clock",
  "accounts",
  "meta",
] as const;

/** Wipes all data and reseeds the deterministic fixture state. */
export function resetDatabase(db: Database, config: ApiConfig): void {
  transaction(db, () => {
    for (const table of DATA_TABLES) {
      db.exec(`DELETE FROM ${table}`);
    }
    db.exec("DELETE FROM sqlite_sequence");
  });
  seedDatabase(db, config);
}

export function readClock(db: Database): string {
  const row = db.prepare("SELECT now FROM clock WHERE id = 1").get() as
    | { now: string }
    | undefined;
  if (row === undefined) {
    throw new Error("Fixture clock is not initialized");
  }
  return row.now;
}

export function writeClock(db: Database, now: string, previous: string): void {
  db.prepare("UPDATE clock SET now = ?, previous = ? WHERE id = 1").run(now, previous);
}

export function readAccounts(db: Database): AccountRow[] {
  return db.prepare("SELECT account_id, display_name, persona FROM accounts ORDER BY account_id").all() as unknown as AccountRow[];
}

export function getAccount(db: Database, accountId: string): AccountRow | null {
  const row = db
    .prepare("SELECT account_id, display_name, persona FROM accounts WHERE account_id = ?")
    .get(accountId) as unknown as AccountRow | undefined;
  return row ?? null;
}

export function readPriceSource(db: Database): PriceSourceState {
  const row = db
    .prepare("SELECT as_of, stale_seconds, unavailable FROM price_source WHERE id = ?")
    .get("dealer-tWETH-fixture") as
    | { as_of: string | null; stale_seconds: number; unavailable: number }
    | undefined;
  if (row === undefined) {
    return { asOf: null, staleSeconds: 0, unavailable: false };
  }
  return {
    asOf: row.as_of,
    staleSeconds: row.stale_seconds,
    unavailable: row.unavailable === 1,
  };
}

export function writePriceSource(db: Database, state: PriceSourceState): void {
  db.prepare(
    "UPDATE price_source SET as_of = ?, stale_seconds = ?, unavailable = ? WHERE id = ?",
  ).run(state.asOf, state.staleSeconds, state.unavailable ? 1 : 0, "dealer-tWETH-fixture");
}

export function resetPriceSource(db: Database): void {
  writePriceSource(db, { asOf: null, staleSeconds: 0, unavailable: false });
}

function eventPayloadJson(event: SettlementEvent): string {
  return JSON.stringify(event);
}

export function insertEvent(
  db: Database,
  event: SettlementEvent,
  orderId: string | null,
): void {
  db.prepare(
    "INSERT INTO event_log (event_id, order_id, event_type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)",
  ).run(event.eventId, orderId, event.type, event.occurredAt, eventPayloadJson(event));
}

export function readEvents(db: Database): SettlementEvent[] {
  const rows = db
    .prepare("SELECT payload_json FROM event_log ORDER BY sequence ASC")
    .all() as unknown as Array<{ payload_json: string }>;
  return rows.map((row) => JSON.parse(row.payload_json) as SettlementEvent);
}

export function countEvents(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM event_log").get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

export function insertJournalEntries(db: Database, entries: readonly JournalEntry[]): void {
  const statement = db.prepare(
    "INSERT OR REPLACE INTO journal (entry_id, order_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)",
  );
  for (const entry of entries) {
    statement.run(
      entry.entryId,
      entry.orderId ?? null,
      entry.occurredAt,
      JSON.stringify(entry),
    );
  }
}

export function readJournalEntries(db: Database): JournalEntry[] {
  const rows = db
    .prepare("SELECT payload_json FROM journal ORDER BY occurred_at ASC, entry_id ASC")
    .all() as unknown as Array<{ payload_json: string }>;
  return rows.map((row) => JSON.parse(row.payload_json) as JournalEntry);
}

export function replaceJournal(db: Database, entries: readonly JournalEntry[]): void {
  transaction(db, () => {
    db.exec("DELETE FROM journal");
    insertJournalEntries(db, entries);
  });
}

export function enqueueOutbox(
  db: Database,
  task: string,
  orderId: string,
  payload: unknown,
  createdAt: string,
): number {
  const result = db
    .prepare(
      "INSERT INTO outbox (task, order_id, payload_json, status, attempts, available_at, created_at) VALUES (?, ?, ?, 'PENDING', 0, 0, ?)",
    )
    .run(task, orderId, payload === null ? null : JSON.stringify(payload), createdAt);
  return Number(result.lastInsertRowid);
}

export function listPendingOutbox(db: Database): OutboxRow[] {
  return db
    .prepare(
      "SELECT id, task, order_id, payload_json, status, attempts, available_at, last_error, created_at FROM outbox WHERE status = 'PENDING' AND available_at <= 0 ORDER BY id ASC",
    )
    .all() as unknown as OutboxRow[];
}

export function pendingOutboxCount(db: Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'PENDING'")
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}
