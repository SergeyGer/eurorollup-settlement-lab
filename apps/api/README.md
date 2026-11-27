# Partner API and order worker

The local partner API for EuroRollup Settlement Lab: typed quotes, order
acceptance, portfolio projections, issuer NAV publication and the evidence used
by gates A02 and A06.

This application performs transport, persistence, authority checks and evidence
capture only. Every settlement rule lives in the pure engine
(`packages/dealing`); the API cannot invent a business rule.

## Run

```bash
pnpm api            # http://127.0.0.1:3000
pnpm demo:partner   # runnable SDK quickstart against an in-process API
pnpm scenario:api   # regenerate the A02 and A06 evidence files
pnpm api:openapi    # regenerate docs/api/openapi.json
```

OpenAPI 3.1 is served at `/openapi.json`. API documentation:
[`docs/api/partner-api.md`](../../docs/api/partner-api.md).

## Architecture

```text
routes -> services -> engine service -> pure dealing engine
                    -> SQLite event log (source of truth)
                    -> journal projection
                    -> outbox worker -> order state + receipts
```

- The durable `event_log` is replayed into a fresh engine on startup.
- New events are applied to an engine clone and adopted only after the SQLite
  transaction that stores the events, the journal and the order projection
  commits.
- The outbox worker is the only component that appends settlement events.
- Fixture clock: no wall-clock value affects a result; dev endpoints move the
  fixture clock forward explicitly.
- Ids come from an injectable factory; evidence runs use a sequential factory so
  outputs are byte-reproducible.

## Endpoints

| Group | Endpoints |
| --- | --- |
| System | `GET /v1/health`, `GET /openapi.json` |
| Partner | `POST /v1/quotes`, `POST /v1/orders`, `GET /v1/orders`, `GET /v1/orders/{id}`, `POST /v1/orders/{id}/cancel`, `GET /v1/portfolios`, `GET /v1/portfolios/{id}` |
| Issuer | `POST /v1/issuer/nav` (requires `x-role-identity`) |
| Policy Lab | `POST /v1/scenarios/drafts`, `PATCH /v1/scenarios/{id}/draft`, `POST /v1/scenarios/{id}/runs`, `GET /v1/scenario-runs/{id}`, `GET /v1/scenario-runs/{id}/evidence` |
| Model | `GET /v1/model/status` |
| Dev | `GET/POST /v1/dev/clock`, `POST /v1/dev/price-source`, `POST /v1/dev/tick`, `POST /v1/dev/reset` |

## Data model

- `quotes`: pre-acceptance offers with price or indicative NAV and dealing terms.
- `orders`: idempotency key, request hash, business state, chain state, reason
  code, dealing date, receipt, money movements and decline details.
- `event_log`: ordered domain events, the source of truth.
- `journal`: per-asset postings derived from events.
- `outbox`: durable settlement tasks (orders) and scenario-run tasks claimed by
  the worker.
- `navs`: authorized issuer observations by valuation date and revision.
- `scenarios`, `scenario_revisions`, `scenario_runs`: Policy Lab drafts,
  confirmation digests and comparison runs.
- `accounts`, `clock`, `price_source`, `meta`: synthetic fixture state.

## Tests

`apps/api/test` contains route, role, OpenAPI, reset and evidence tests.
`pnpm test` runs them together with the engine and fixture suites.

## Policy Lab runs

`ScenarioService` builds drafts with `@eurorollup/policy-lab`, stores revisions
and confirmation digests, queues a run through the outbox and executes the
two-branch replay in the worker. Scenario storage has no settlement write
credentials: a comparison only replays frozen fixtures through the pure engine.

## Scope boundaries

- Chain state is `NOT_SUBMITTED` until the pinned rollup integration (S06).
- Eligibility personas are stored, not enforced, until S05.
- Live model drafting requires the local Ollama runtime and the pinned model;
  when it is unreachable the endpoint returns a recoverable `503` and the manual
  and recorded paths remain usable.
