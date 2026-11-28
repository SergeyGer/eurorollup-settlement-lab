/**
 * Runtime configuration for the local partner API.
 *
 * Everything that affects computed results is configuration or frozen fixture
 * data: calendar, policy, fixture clock start, dealer price, indicative NAV and
 * the synthetic investor accounts. No wall-clock time is used by the domain
 * paths.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createBaselinePolicy,
  validateCalendar,
  type DealingCalendar,
  type FundDealingPolicy,
} from "@eurorollup/dealing";
import labUtc1Json from "../../../fixtures/calendar/LAB-UTC-1.json";
import labUtc2Json from "../../../fixtures/calendar/LAB-UTC-2.json";
import type { CalendarFixture } from "@eurorollup/dealing";
import { randomIdFactory, type IdFactory } from "./ids.js";

export const SERVICE_VERSION = "0.5.0";
export const SCHEMA_VERSION = "1.0.0";
export const DATA_MODE = "local-fixture";
export const FIXTURE_CLOCK_START = "2026-11-20T15:00:00Z";
export const FIXTURE_DEALER_PRICE_BASE = 2_000_000_000n; // 2,000.00 EUR per tWETH
export const FIXTURE_INDICATIVE_NAV_BASE = 100_000_000n; // 100.00 EUR per eFUND
export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";
export const ISSUER_ROLE_IDENTITY = "issuer-nav-signer";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:4b";
export const DEFAULT_MODEL_TIMEOUT_MS = 15_000;
export const DEALER_PRICE_SOURCE_ID = "dealer-tWETH-fixture";

export type CalendarId = "LAB-UTC-1" | "LAB-UTC-2";

export interface SeedInvestor {
  readonly accountId: string;
  readonly displayName: string;
  readonly persona: "verified" | "basic" | "flagged";
}

export const SEED_INVESTORS: readonly SeedInvestor[] = [
  { accountId: "investor-ada", displayName: "Ada (synthetic, verified)", persona: "verified" },
  { accountId: "investor-bea", displayName: "Bea (synthetic, verified)", persona: "verified" },
  { accountId: "investor-cy", displayName: "Cy (synthetic, basic)", persona: "basic" },
  { accountId: "investor-dee", displayName: "Dee (synthetic, flagged)", persona: "flagged" },
];

export const ENGINE_ACCOUNT_IDS = {
  dealer: "dealer-inventory",
  feeRecipient: "fee-recipient",
  issuerTreasury: "issuer-treasury",
  issuanceControl: "issuance-control",
  fundEscrow: "fund-escrow",
} as const;

const CALENDAR_FIXTURES: Readonly<Record<CalendarId, CalendarFixture>> = {
  "LAB-UTC-1": labUtc1Json as unknown as CalendarFixture,
  "LAB-UTC-2": labUtc2Json as unknown as CalendarFixture,
};

const CALENDAR_JSON: Readonly<Record<CalendarId, unknown>> = {
  "LAB-UTC-1": labUtc1Json,
  "LAB-UTC-2": labUtc2Json,
};

export interface ApiConfigOptions {
  readonly dataDir?: string;
  readonly dbFile?: string;
  readonly host?: string;
  readonly port?: number;
  readonly calendarId?: CalendarId;
  readonly devEndpoints?: boolean;
  readonly autoWorker?: boolean;
  readonly ids?: IdFactory;
  readonly ollamaBaseUrl?: string;
  readonly ollamaModel?: string;
  readonly modelTimeoutMs?: number;
  readonly chainWitnessPath?: string | null;
}

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly dbFile: string;
  readonly calendar: DealingCalendar;
  readonly calendarFixture: CalendarFixture;
  readonly policy: FundDealingPolicy;
  readonly fixtureClockStart: string;
  readonly dealerSpotPriceBase: bigint;
  readonly indicativeNavBase: bigint;
  readonly devEndpoints: boolean;
  readonly issuerRoleIdentity: string;
  readonly serviceVersion: string;
  readonly dataMode: string;
  readonly autoWorker: boolean;
  readonly ids: IdFactory;
  readonly seedInvestors: readonly SeedInvestor[];
  readonly ollamaBaseUrl: string;
  readonly ollamaModel: string;
  readonly modelTemperature: number;
  readonly modelSeed: number;
  readonly modelTimeoutMs: number;
  readonly chainWitnessPath: string | null;
}

/** Repository root, resolved from this module rather than the process cwd. */
export function repositoryRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

export function loadCalendar(calendarId: CalendarId): DealingCalendar {
  const fixture = CALENDAR_FIXTURES[calendarId];
  return validateCalendar({
    calendarId: fixture.calendarId,
    version: fixture.version,
    timezone: fixture.timezone,
    ...(fixture.dealingDays === undefined ? {} : { dealingDays: fixture.dealingDays }),
    ...(fixture.closedDates === undefined ? {} : { closedDates: fixture.closedDates }),
    ...(fixture.description === undefined ? {} : { description: fixture.description }),
  });
}

export function createApiConfig(options: ApiConfigOptions = {}): ApiConfig {
  const calendarId = options.calendarId ?? "LAB-UTC-1";
  const dataDir = options.dataDir ?? resolve(repositoryRoot(), ".data");
  return {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    dbFile: options.dbFile ?? resolve(dataDir, "api.sqlite"),
    calendar: loadCalendar(calendarId),
    calendarFixture: CALENDAR_FIXTURES[calendarId],
    policy: createBaselinePolicy(),
    fixtureClockStart: FIXTURE_CLOCK_START,
    dealerSpotPriceBase: FIXTURE_DEALER_PRICE_BASE,
    indicativeNavBase: FIXTURE_INDICATIVE_NAV_BASE,
    devEndpoints: options.devEndpoints ?? true,
    issuerRoleIdentity: ISSUER_ROLE_IDENTITY,
    serviceVersion: SERVICE_VERSION,
    dataMode: DATA_MODE,
    autoWorker: options.autoWorker ?? true,
    ids: options.ids ?? randomIdFactory(),
    seedInvestors: SEED_INVESTORS,
    ollamaBaseUrl:
      options.ollamaBaseUrl ??
      process.env["OLLAMA_BASE_URL"] ??
      DEFAULT_OLLAMA_BASE_URL,
    ollamaModel: options.ollamaModel ?? process.env["OLLAMA_MODEL"] ?? DEFAULT_OLLAMA_MODEL,
    modelTemperature: 0,
    modelSeed: 42,
    modelTimeoutMs:
      options.modelTimeoutMs ??
      (process.env["MODEL_TIMEOUT_MS"] === undefined
        ? DEFAULT_MODEL_TIMEOUT_MS
        : Number(process.env["MODEL_TIMEOUT_MS"])),
    chainWitnessPath:
      options.chainWitnessPath ??
      (process.env["CHAIN_WITNESS_PATH"] === undefined ? null : process.env["CHAIN_WITNESS_PATH"]),
  };
}

export function calendarFixtureJson(calendarId: CalendarId): unknown {
  return CALENDAR_JSON[calendarId];
}
