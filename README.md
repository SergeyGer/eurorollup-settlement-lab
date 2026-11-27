# EuroRollup Settlement Lab

An open-source euro settlement sandbox for crypto trades and tokenized fund
orders, with an AI Policy Lab that turns a plain-English dealing-rule question
into a confirmed, replayable comparison.

> Synthetic data only. The sandbox uses invented balances, prices, instruments
> and identities. It moves no real funds, serves no real investors, and is not
> financial, legal or regulatory advice.

## What the project demonstrates

A crypto purchase has filled while a fund subscription waits for its net asset
value (NAV). The sandbox explains exactly when cash becomes an asset, reserves
pending cash explicitly, and links every state change to a reproducible
receipt.

| Journey | What a visitor can do |
| --- | --- |
| Investor portfolio | Buy or sell test wrapped ETH, subscribe or redeem fictional fund units, inspect cash reservations and policy holds. |
| Product owner workspace | Ask an English question about the weekly fund cutoff, inspect the typed rule change, confirm it and compare affected orders side by side. |
| Institutional developer | Place the same orders through the typed API, reproduce a scenario from saved policy versions, and verify the evidence pack with a command-line verifier. |
| Issuer and operator | Publish a synthetic NAV, rotate an eligibility root, diagnose a delayed batch and recover a projection, each with a defined authority and audit event. |
| Public visitor | Watch the release film, step through the recorded settlement and run the reference policy comparison in the browser. |

Model output and computed simulation results are always labelled separately:
a proposal is not an execution, and every numerical outcome is calculated by the
deterministic engine after confirmation.

## Golden fixtures

All figures below are frozen inputs in `fixtures/` and are asserted by tests.

### G01 — one investor and two investment lifecycles

| Investor checkpoint | Spendable dEUR | Reserved dEUR | tWETH | eFUND |
| --- | --- | --- | --- | --- |
| Seed | 1,000.00 | 0.00 | 0 | 0 |
| Buy €200 at €2,000 per tWETH | 799.95 | 0.00 | 0.100000 | 0 |
| Request €300 at indicative NAV €100 | 499.95 | 300.00 | 0.100000 | 0 |
| Strike and settle at NAV €96 | 499.95 | 0.00 | 0.100000 | 3.125000 |

Closing portfolio value at the fixture marks of €2,000 and €96 is €999.95. A
separate redemption case redeems one unit at €98 and leaves €597.95 spendable
and 2.125000 units.

### P01 — the Friday cutoff experiment

Two independent €300 fund subscriptions from two verified investors, each
starting with €1,000:

| Order received Friday | Baseline · 16:00 cutoff | Candidate · 15:00 cutoff |
| --- | --- | --- |
| F-1450 · 14:50 UTC | Friday allocation, 3.125000 units at €96 | Friday allocation, 3.125000 units at €96 |
| F-1530 · 15:30 UTC | Friday allocation, 3.125000 units at €96 | Monday allocation, 3.000000 units at €100 |

Result card: **1 of 2 orders changes dealing date** and **€300 more reserved at
Friday close**. F-1530 settles 72 hours later and receives 0.125000 fewer units
at the supplied Monday NAV.

## Replay preview

The browser replay steps through the recorded G01 settlement with the pure
dealing engine running locally. While the fund request awaits its authorized
NAV, EUR 300.00 is displayed once as pending cash and is not counted as a
holding:

![Recorded replay: spendable EUR 499.95 and EUR 300.00 pending while awaiting NAV](docs/media/s01-portfolio-reserved.jpg)

See [`docs/verification/s01-foundation.md`](docs/verification/s01-foundation.md)
for the verified checkpoints, receipts and digests of the foundation step.

## Quick start

Requirements: Node.js 22 or newer and pnpm 9 or newer
(`corepack enable` provides pnpm).

```bash
pnpm install
pnpm test          # deterministic unit and fixture tests
pnpm typecheck     # TypeScript project checks
pnpm scenario:golden   # replay G01 and write the evidence pack
pnpm dev           # portfolio replay in the browser
```

See [`docs/`](docs/README.md) for architecture, fixtures, evidence formats and
the delivery plan, and the project Wiki for the reader-facing project pages.

## Repository layout

```text
apps/web            Browser replay and portfolio UI
apps/api            HTTP API and workers (scenario and settlement services)
packages/dealing    Pure deterministic dealing engine shared by browser, CLI and worker
packages/policy-lab Typed AI proposal schemas and model adapters
packages/sdk        Typed partner SDK
contracts           Foundry contracts (spot router, fund vault, share token)
circuits            Noir eligibility circuit and vectors
fixtures            Frozen synthetic inputs (G01, P01, calendars, instruments)
schemas             Versioned JSON Schemas for receipts, journals and evidence packs
evidence            Committed evidence packs for released gates
docs                Architecture, fixtures, plan, ADRs and verification notes
```

## Delivery status and roadmap

The project is delivered in documented steps tracked as GitHub Issues and
Milestones. Each step closes only when its fixtures, tests and evidence are
merged, and larger steps are tagged as GitHub Releases.

- Current stage: foundation released as `v0.1.0` — frozen fixtures, integer
  money arithmetic, versioned UTC calendar, the G01 portfolio replay with a
  reproducible evidence pack, and a basic browser replay.
- Next: settlement core and partner API (step S02), then policy-lab simulation,
  live model adapter, account abstraction and eligibility, pinned local rollup,
  economics and operations, verification gates A01–A09, public release and the
  release film.

See the development roadmap in the GitHub Issues and
[`docs/plan/roadmap.md`](docs/plan/roadmap.md).

## Security

The sandbox is synthetic and local-first. Local credentials are never committed:
the maintainer's GitHub token lives in an ignored `.git-token` file. Dependency
alerts, secret scanning, push protection and branch protection are enabled on
the repository. Please report vulnerabilities according to
[`SECURITY.md`](SECURITY.md).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
