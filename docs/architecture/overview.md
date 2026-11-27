# Architecture overview

EuroRollup Settlement Lab is a TypeScript monorepo with one web application, an
API and worker, a relational projection, a pure dealing engine shared by the
worker and the browser, and a later pinned local rollup with Foundry contracts
and a Noir eligibility circuit.

The product contribution is not a new protocol. It is a reproducible link
between a product rule, the investor's cash position and the supporting
settlement evidence.

## Components

| Component | Authoritative responsibility | Evidence exposed |
| --- | --- | --- |
| Portfolio and partner API | Capture an intent, disclose charges, present spendable and pending positions | Intent ID, quote expiry, policy reason, account statement |
| Dealer, issuer and policy services | Serve seeded spot quotes, signed NAVs and current eligibility roots, with a separate local identity per role | Signed input version, valuation date, source time, policy epoch |
| EntryPoint, bundler and paymaster | Validate the smart account and sponsor an approved operation up to its budget | UserOperation hash, outer transaction hash, sponsor deposit movements |
| Spot router, fund vault and share token | Exchange spot legs atomically; escrow, allocate or return cash and units; enforce fund movement rules | Receipt events, cash and inventory legs, share supply and escrow balances |
| Indexer, journal and verifier | Derive a per-asset journal from canonical events; compare contract balance reads at the same block | Block hash, finality level, ledger postings, reconciliation differences |
| AI Policy Lab and simulation worker | Validate and confirm a typed rule, freeze an input snapshot, replay two branches through the shared dealing engine | Proposal version, confirmation digest, per-order changes, comparison manifest |

Scenario storage carries no settlement write credentials. The model adapter
process has one capability: drafting a typed scenario.

## Implementation status

The foundation and settlement-core steps are implemented:

- `packages/dealing` is the shared pure engine (fixtures, calendar, money, spot,
  fund, journal, receipts, evidence builders).
- `apps/api` is the local partner API with a durable event log, journal
  projection, outbox worker, issuer authority and local fixture controls.
- `packages/sdk` is the typed, dependency-free partner client.
- `apps/web` has two views: the recorded G01 replay and the live Local API lab.

The Policy Lab, subscription worker, eligibility circuit and pinned rollup are
added by the later steps.

## Local partner API

```text
routes -> services -> engine service -> pure dealing engine
                    -> SQLite event log (source of truth)
                    -> journal projection
                    -> outbox worker -> order state + receipts
```

- The durable `event_log` is replayed into a fresh engine on startup; the
  journal, order rows and outbox are projections over that log.
- New events are applied to an engine clone and adopted only after the SQLite
  transaction that stores events, journal and projection commits.
- The outbox worker is the only component that appends settlement events, so an
  accepted order keeps its id through retries and restarts.
- A fixture clock provides every observation time; dev endpoints move it forward
  explicitly and no wall-clock value affects a result.
- Market and fund marks carry provenance (`dealer-fixture-quote`,
  `authorized-nav`, `indicative-fixture-nav`) and a stale flag; `blockHash` is
  `null` until a chain reader is attached.

## Two independent state fields

**Business state.** A spot order progresses through `quoted`, `submitted` and
`filled`, or ends `expired` or `declined`. A fund request progresses through
`reserved`, `awaiting_nav` and `allocated`, or ends `redeemed`, `cancelled` or
`held`. A policy hold preserves escrow; cancellation and refund are explicit
events.

**Chain state.** `submitted`, `unsafe`, `safe` and `finalized` are recorded
independently. A later safe or finalized observation can advance a receipt. If
the canonical chain replaces an unsafe block, its effects are marked superseded
and rebuilt from the common ancestor. A blocked preflight has no transaction
hash.

The two fields are never merged: a fund request can be `awaiting_nav` with no
chain transaction at all, and a submitted transaction can fail at execution
while the business intent remains attributed.

## Determinism rules

1. Amounts are integer base units; serialization is decimal strings.
2. The pure dealing engine is the only place that assigns dealing days,
   computes unit issuance, moves cash between buckets and produces postings.
   The worker, the browser and the CLI all call the same functions.
3. Replay starts from a snapshot before the first order and applies ordered
   intents and external observations (NAVs, calendar and policy observations)
   respecting observation time.
4. Each simulation branch runs in isolated state. The confirmed policy patch is
   the only variable.
5. A stable business digest is computed over canonical JSON (sorted object keys,
   stable array order) hashed as UTF-8 with SHA-256. Model prose, execution
   timestamps and run IDs are excluded.
6. A fixed confirmed patch produces the same hash in the browser, the local
   service and the CLI.

## Money and rounding

- dEUR and eFUND use 6 decimals; tWETH uses 18 decimals.
- Issued fund units are rounded down; residual cash returns to the investor.
- A zero-unit fill is rejected.
- The spot lane charges a fixed EUR 0.05 investor charge as an explicit
  settlement leg. The fund lane charges the investor EUR 0.
- Stale prices are refused: spot quote price sources older than 60 seconds are
  rejected before acceptance.

## Settlement flows

### G01 portfolio lifecycle

1. Seed 1,000.00 dEUR.
2. Spot buy 200.00 dEUR at 2,000.00 EUR per tWETH: cash 200.00 plus a 0.05
   charge leaves; 0.100000 tWETH arrives.
3. Fund subscription of 300.00 dEUR: cash is reserved, units are not issued.
4. NAV authorization at 96.00 EUR per unit: 3.125000 units are issued, the
   reserved cash becomes the issuer treasury and no residual remains.
5. Marked value at the fixture marks: 0.1 x 2,000 + 3.125 x 96 + 499.95 =
   999.95 dEUR.

### P01 Friday cutoff experiment

Baseline weekly subscription cutoff Friday 16:00 UTC, candidate 15:00 UTC.
Order F-1450 (14:50) settles Friday in both branches; order F-1530 (15:30)
settles Friday in the baseline and Monday in the candidate. Both branches spend
600.00 dEUR. The candidate leaves 300.00 dEUR more reserved at Friday close and
delivers 0.125000 fewer units to F-1530 at the supplied Monday NAV.

## Repository layout

```text
apps/web             Browser replay and portfolio UI
apps/api             HTTP API, order worker and simulation worker
packages/dealing     Pure deterministic dealing engine
packages/policy-lab  Typed AI proposal schemas and adapters
packages/sdk         Typed partner SDK
contracts            Foundry contracts
circuits             Noir eligibility circuit and vectors
fixtures             Frozen synthetic inputs
schemas              Versioned JSON Schemas
evidence             Committed evidence packs
docs                 Architecture, plan, fixtures, evidence, ADRs
```

## Domain boundaries

- Synthetic balances, prices and identities only.
- Public surface may contain wallet addresses, amounts, timing, public proof
  inputs and eligibility epochs. Names, countries, account-to-person tables and
  private witnesses never appear in calldata, events, URLs or telemetry.
- The model adapter cannot sign, shell out, call chain RPC methods or write
  portfolio state.
- Scenario storage has no settlement write credentials.

## Design references

The design studies the OP Stack devnet package, Account Abstraction/ERC-4337,
ERC-3643, Centrifuge, ERC-7540 and the EU regulatory references listed in the
specification's source register. None of these are bundled as production code;
measurements and evidence always come from this repository's own synthetic
fixtures and pinned local network.
