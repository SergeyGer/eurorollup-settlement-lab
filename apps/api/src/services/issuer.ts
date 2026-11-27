/**
 * Issuer authority: publishing authorized synthetic NAV observations.
 *
 * The issuer identity is separate from the investor and operator surfaces and is
 * required on the restricted endpoint. Publishing a NAV observation enqueues
 * deterministic settlement attempts for every order assigned to that valuation
 * date; the worker performs the actual allocation.
 */
import {
  formatDisplayAmount,
  instantDifferenceMs,
  parseBaseUnits,
  parseUtcDate,
} from "@eurorollup/dealing";
import type { NavPublicationRequest, NavPublicationResult } from "@eurorollup/sdk";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db.js";
import { enqueueOutbox, readClock, transaction } from "../db.js";
import type { ClockService } from "../clock-service.js";
import type { EngineService } from "../engine-service.js";
import { problem, unauthorizedRole } from "../problems.js";
import {
  getNavRow,
  listOrdersAwaitingDate,
  upsertNav,
  type NavRow,
} from "../repository.js";
import { OUTBOX_TRY_SETTLE } from "./orders.js";

export class IssuerService {
  private readonly db: Database;
  private readonly config: ApiConfig;
  private readonly engine: EngineService;
  private readonly clock: ClockService;

  constructor(db: Database, config: ApiConfig, engine: EngineService, clock: ClockService) {
    this.db = db;
    this.config = config;
    this.engine = engine;
    this.clock = clock;
  }

  publishNav(
    input: NavPublicationRequest,
    roleIdentity: string | undefined,
  ): NavPublicationResult {
    if (roleIdentity !== this.config.issuerRoleIdentity) {
      throw unauthorizedRole(this.config.issuerRoleIdentity);
    }
    if (input.assetId !== "eFUND") {
      throw problem(422, "UNSUPPORTED_ORDER", "Only eFUND NAV observations are supported", {
        assetId: input.assetId,
      });
    }
    parseUtcDate(input.valuationDate).toString();
    const navBase = parseBaseUnits(input.navBase);
    if (navBase <= 0n) {
      throw problem(400, "INVALID_AMOUNT", "NAV must be positive base units");
    }
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      throw problem(400, "INVALID_REQUEST", "Revision must be a positive integer");
    }
    const now = readClock(this.db);
    if (instantDifferenceMs(now, input.sourceTime) < 0) {
      throw problem(422, "NAV_SOURCE_TIME_IN_FUTURE", "The NAV source time is after the fixture clock", {
        sourceTime: input.sourceTime,
        clock: now,
      });
    }
    const existing = getNavRow(this.db, "eFUND", input.valuationDate);
    if (existing !== null && input.revision <= existing.revision) {
      throw problem(
        409,
        "NAV_REVISION_NOT_NEWER",
        "A NAV observation with this or a newer revision already exists",
        { existingRevision: existing.revision, revision: input.revision },
      );
    }
    const navRow: NavRow = {
      asset_id: "eFUND",
      valuation_date: input.valuationDate,
      nav_base: navBase.toString(),
      source_time: input.sourceTime,
      revision: input.revision,
      signer: this.config.issuerRoleIdentity,
      observed_at: now,
    };
    const queuedOrderIds: string[] = [];
    transaction(this.db, () => {
      upsertNav(this.db, navRow);
      for (const order of listOrdersAwaitingDate(this.db, input.valuationDate)) {
        enqueueOutbox(this.db, OUTBOX_TRY_SETTLE, order.order_id, null, now);
        queuedOrderIds.push(order.order_id);
      }
    });
    this.engine.applyEvents(
      [
        {
          type: "nav.observed",
          eventId: `EV-NAV-eFUND-${input.valuationDate}-r${input.revision}`,
          occurredAt: now,
          assetId: "eFUND",
          valuationDate: input.valuationDate,
          navBase: navBase.toString(),
          sourceTime: input.sourceTime,
          revision: input.revision,
          signer: this.config.issuerRoleIdentity,
        },
      ],
      { mutate: () => undefined },
    );
    return {
      assetId: "eFUND",
      valuationDate: input.valuationDate,
      navBase: navBase.toString(),
      navEurPerUnit: formatDisplayAmount(navBase, 6, 2),
      sourceTime: input.sourceTime,
      revision: input.revision,
      signer: this.config.issuerRoleIdentity,
      observedAt: now,
      queuedOrderIds: queuedOrderIds.sort(),
    };
  }
}
