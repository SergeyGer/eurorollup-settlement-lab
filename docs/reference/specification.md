# EuroRollup Settlement Lab — Development Specification

> Reference copy of the project specification.
>
> Source document: [`EuroRollup_Settlement_Lab_Final_Development_Specification_EN.docx`](EuroRollup_Settlement_Lab_Final_Development_Specification_EN.docx)
> (the DOCX is preserved verbatim in this directory and remains the normative source).
> This Markdown conversion is provided for review convenience.
>
> The specification describes a synthetic-data research sandbox. It is not
> financial, legal or regulatory advice, and it does not describe a production
> settlement system.

OPEN SOURCE  /  DEVELOPMENT SPECIFICATION
# EuroRollup Settlement Lab
Multiasset settlement and AI policy simulation
Build a euro investment sandbox for crypto trades and tokenized bond fund orders. Show exactly when cash becomes an asset. Give a product owner a way to propose a fund rule in English, test it against the same orders, and see which investors would wait longer.

Opening frame concept. A crypto purchase has filled while a fund subscription awaits its net asset value (NAV).
### The release demonstration
| Release demonstration | Visible result |
| --- | --- |
| Invest €200 in test ether and subscribe €300 to a bond fund. | A receipt explains the charge, the cash reserved and the fund units eventually issued. |
| Ask how a 15:00 UTC Friday cutoff would affect two orders. | Inspect the AI proposal, confirm the rule, and see Friday and Monday outcomes side by side. |
| Download a settlement run and a simulation comparison. | Reproduce the portfolio and the affected order locally from versioned inputs. |
### How to read this specification
- Scope and ownership — AI Policy Lab
- Investment rules and example — Friday cutoff worked example
- Rollup architecture — Release acceptance tests
- Partner API and receipts — One minute film and narration
### Release boundary
Ship a local L1/L2 network, a public interactive replay, a working local language-model adapter and a narrated film. The sandbox uses synthetic balances, prices and identities. Public visitors can run the recorded example without a wallet or model key.
Proposed repository   SergeyGer/eurorollup-settlement-lab     •     Specification date   24 November 2026

**01  /  RELEASE SCOPE**

## What the platform must deliver
A distributor needs to explain an investment after settlement. A product owner needs to predict the operational effect of a dealing rule before adoption. Deliver both journeys with evidence that another developer can reproduce.
| Release surface | Required outcome |
| --- | --- |
| Investor portfolio | Buy or sell test wrapped ETH, subscribe or redeem fictional fund units, inspect cash reservations and see policy holds. Each state links to its receipt. |
| Product owner workspace | Open AI Policy Lab, propose a weekly cutoff change, inspect the typed change, confirm it and compare affected orders. Export the inputs, policy versions and order-level differences. |
| Institutional developer | Place orders through the typed API and verify the same balances as the UI. Reproduce a scenario using a saved policy change and the command-line verifier. |
| Issuer and operator | Publish a synthetic NAV, rotate an eligibility root, diagnose a delayed batch and recover the projection. Each action has a defined authority and audit event. |
| Public visitor | Watch the release film, step through a recorded settlement and run the reference policy comparison in the browser. Label recorded model output and computed simulation results separately. |
| Operating boundary | Use a private development rollup and synthetic instruments. Restrict AI simulations to isolated snapshots. Changes to the active policy follow the separate governance procedure. |
### Definition of delivery
Release 1.0 consists of a tagged repository, local setup, public replay, independently verifiable evidence packs, partner documentation and a one-minute narrated MP4. Link every required feature to gates A01–A09 and the exact release commit.

**02  /  PRODUCT AND PRECEDENTS**

## Where the project adds value
Use established implementations for protocol and token mechanics. The product contribution is a reproducible link between a product rule, the investor’s cash position and the supporting settlement evidence.
| Open-source reference | What to reuse or study | What EuroRollup must demonstrate |
| --- | --- | --- |
| OP Stack devnet package [1] | Reproducible L1 and L2 deployment and network configuration. | A change in batch policy has a measured effect on the time an investor receipt takes to become safe. |
| Account Abstraction reference [2] | EntryPoint, accounts and sponsorship examples. | One product shows a fixed euro charge, the actual native fee and who absorbs the difference. |
| ERC-3643 suite [3] | Identity-aware transfer restrictions for permissioned units. | A single portfolio explains why a fund order waits or is declined while an eligible crypto order can execute. |
| Centrifuge protocol [4] | Onchain asset management and share accounting precedents. | A small, independently replayable case joins a spot fill, a fund valuation and a balance reconciliation. |
### Users and product hypotheses
Investor. Can I tell what I own, how much cash I can still spend and why my fund order is pending? In a five-person usability pilot, ask participants to find all three answers unaided. Target four correct completions. Publish the script and the actual sample size.
Distributor developer. Can I integrate a new order and verify the receipt? Run the quickstart on a clean checkout with the SDK and measure time to first verified receipt. Target 15 minutes with downloaded images. Report initial image-download time separately.
Product owner. Given two Friday orders, can I identify which changes dealing date, how much cash stays reserved and when it releases? In the pilot, require the participant to point to the affected row and the confirmed rule.
Issuer and operator. Can I explain an eligibility decision or a delayed valuation without consulting a database by hand? In the incident exercise, capture the decision code, affected orders, responsible component and recovery proof from one trace.
| Product tradeoff.  A third asset class enters the backlog only when the two existing lifecycles reconcile, a developer can reproduce the release run and users can explain pending cash. |
| --- |

**03  /  DEALING RULES**

## One portfolio and two investment lifecycles
The common cash leg is dEUR, a six-decimal demo token. The investor holds a smart account on the L2. A funded inventory account supplies test wrapped ETH. A separate vault issues fictional units in a euro short-duration bond fund.
| Rule | Crypto spot  ·  tWETH | Fund subscription  ·  eFUND |
| --- | --- | --- |
| Execution | 24/7 fixture clock. A signed quote names the account, size, price, expiry and total charge. It lasts 30 seconds. | Requests before 16:00 UTC on a fixture dealing day enter that day’s batch. At or after cutoff, weekends or fixture holidays move to the next dealing day. |
| Pricing | 18-decimal token. Settle cash, inventory and a €0.05 charge atomically. Refuse a quote if its price source is over 60 seconds old. | 6-decimal units. Show the prior NAV as indicative. Mint on an authorized NAV for the assigned date. Missing or stale NAV keeps cash reserved. The investor pays €0 in this lane. |
| Exit | Support a reverse quote and check inventory and minimum proceeds before settlement. | Reserve units on redemption and use the next applicable NAV. Burn and pay atomically when liquidity and policy checks pass. Release an eligible cancellation before cutoff. |
### Golden fixture G01
| Investor checkpoint | Spendable dEUR | Reserved dEUR | tWETH | eFUND |
| --- | --- | --- | --- | --- |
| Seed | 1,000.00 | 0.00 | 0 | 0 |
| Buy €200 at €2,000 per tWETH | 799.95 | 0.00 | 0.100000 | 0 |
| Request €300 at indicative NAV €100 | 499.95 | 300.00 | 0.100000 | 0 |
| Strike and settle at NAV €96 | 499.95 | 0.00 | 0.100000 | 3.125000 |
At the fixture marks of €2,000 and €96, the closing portfolio value is €999.95. Display €300 cash pending once. On allocation, replace it with 3.125000 units. In a separate redemption case, one unit at €98 brings spendable cash to €597.95 and units to 2.125000.
### Precision and exceptional cases
Use integer base units and serialize amounts as decimal strings. Round issued units down and return residual cash to the investor. Reject a zero-unit fill. Keep a versioned UTC calendar. A corrected NAV carries a separate revision and adjustment event. Settled entries remain auditable. Use the asynchronous vault standard as a design reference for the custom dealing interface. [12]

**04  /  AI POLICY LAB**

## From a policy question to a confirmed rule
The product owner asks “What if the fund moved its Friday cutoff from 16:00 to 15:00 UTC?” The model translates the question. The application displays the proposed change and waits for confirmation before calculating its effects.
| Screen state | Interaction and acceptance condition |
| --- | --- |
| 1   Select inputs | Show eFUND, the active baseline version, fixture set and calendar. Offer the Friday question as a preset and a plain English input in local mode. Keep dates and times visibly in UTC. |
| 2   Review proposal | Show one structured diff: Friday subscription cutoff, 16:00 → 15:00 UTC. Display asset, order type, weekday, old/new times and fixture. The user may edit the supported fields or cancel. Editing produces a new revision. |
| 3   Clarify or reject | An unclear target, weekday or timezone opens a short clarification prompt. Show an unsupported request as such. Preserve the user’s text so they can revise it. Neither state enables Run. |
| 4   Confirm and run | The button “Confirm and compare” binds the visible diff to the baseline version and fixture digest. Only a valid, current proposal can run. Disable duplicate submission while the comparison is in progress. |
| 5   Read the impact | Lead with affected/total orders and extra cash reserved at Friday close. Show one row per order with baseline and candidate dates, reserved cash, units and a reason. Provide a timeline, a comparison download and Reset. |
### Supported rule in release 1.0
Support a single change to the weekly subscription cutoff for eFUND on one named dealing weekday. Allow Monday to Friday and whole-minute UTC times from 00:01 to 16:59 so every eligible order precedes the 17:00 valuation. Keep redemption deadlines, NAV sources, fees and eligibility rules fixed. A question about several changes requires narrowing the scope.
### Public and local experience
In the public browser demo, the preset loads a labeled recorded AI proposal. Visitors can edit its time, confirm and recompute both branches locally from bundled inputs. In Local AI mode, free text goes through a real model adapter. Require a recorded live-adapter example in the release. A model outage leaves the manual editor and recorded preset available.

**05  /  LANGUAGE MODEL CONTRACT**

## Proposal schema and service boundaries
Accept one constrained operation. The model receives the question, supported fields and current rule summary. It returns a proposal, a clarification request or an unsupported result. All numerical outcomes are calculated after confirmation.
### Example of a valid model proposal
```json
{
  "status": "proposed",
  "operation": "set_subscription_cutoff", "asset": "eFUND",
  "weekday": "FRI", "timeUtc": "15:00", "timezone": "UTC",
  "expectedTimeUtc": "16:00"
}
```
Publish a discriminated JSON Schema with additionalProperties=false. For proposed, require operation, asset, weekday, timeUtc and timezone. expectedTimeUtc is optional and represents a prior time stated by the user. For clarify require a question and missingFields list. For unsupported require a reasonCode. Limit text to 500 characters and accept only the documented enums.
### Inputs the server owns
Derive scenario ID, baseline policy/version, fixture hash, session owner and proposed revision on the server. Load the current cutoff from the baseline. Reject a stated prior time that disagrees with it. A valid request equal to the current rule returns NO_CHANGE. A bare local time or “an hour earlier” can be resolved only when its weekday, timezone and reference cutoff are unambiguous in the displayed context.
### Execution boundary
Provide a working local inference adapter with a documented, pinned model identifier or digest, prompt version and setup command. Use one structured response per attempt. On malformed output, retry once with schema feedback; after a second failure or a configured 15-second deadline per attempt, return a recoverable error. Never silently reinterpret a failed free-text request as the preset.
The adapter receives synthetic rule metadata and the short question. Its process has no signing keys, shell tools, chain RPC methods or access to portfolio writes. Validate all output before display. Text that proposes unsupported operations, executable content or additional fields cannot reach confirmation. Store the typed result and versions. Keep raw free text session-local by default.
### Reviewable evidence
Display proposal origin as Live model, Recorded proposal or Manual edit. A manual edit keeps a link to the parent revision. Record which normalized fields the user approved, the confirmation time and the resulting comparison ID. The same approved proposal must replay with the model offline.

**06  /  CANONICAL SIMULATION**

## The Friday cutoff experiment
Fixture P01 contains two independent €300 fund subscriptions from two verified investors. Each starts with €1,000. Use the same inputs in both branches. This fixture is separate from the single-investor portfolio example G01.
### Frozen inputs
Friday 20 November 2026 and Monday 23 November 2026 are dealing days in calendar LAB-UTC-1. Saturday and Sunday are closed. Both NAVs arrive at 17:00 UTC, Friday at €96 and Monday at €100. Use separate signed observations for each date. Orders accepted strictly before cutoff receive that day’s NAV. Exact cutoff advances to the next dealing day.
| Order received Friday | Baseline · Friday 16:00 | Candidate · Friday 15:00 |
| --- | --- | --- |
| F-1450  /  14:50 UTC | Friday allocation. €300 / €96 = 3.125000 units. | Friday allocation. 3.125000 units. The order arrived before both cutoffs. |
| F-1530  /  15:30 UTC | Friday allocation. €300 / €96 = 3.125000 units. | Monday allocation. €300 / €100 = 3.000000 units. The order missed the proposed Friday cutoff. |
### Expected portfolio and timing differences
| Snapshot across both accounts | Baseline | Candidate |
| --- | --- | --- |
| Friday 17:01 UTC | €1,400 spendable, €0 reserved, 6.250000 units | €1,400 spendable, €300 reserved, 3.125000 units |
| Monday 17:01 UTC | €1,400 spendable, €0 reserved, 6.250000 units | €1,400 spendable, €0 reserved, 6.125000 units |
The result card reads “1 of 2 orders changes dealing date” and “€300 more reserved at Friday close”. F-1530 settles 72 hours later and receives 0.125000 fewer units at the supplied Monday NAV. The reduction is a property of these fixture prices. Show that both branches spent €600 and that the difference in unit count is distinct from cash spent.
### Boundary fixtures
Run separate cases at 14:59:59, 15:00:00 and 16:00:00 UTC on Friday. Expected baseline/candidate days are Fri/Fri, Fri/Mon and Mon/Mon. Mark Monday closed in an alternate calendar and supply a Tuesday NAV to test Tuesday assignment. If Monday is open but its NAV is missing, keep the candidate F-1530 pending with €300 reserved and units outstanding.

**07  /  SIMULATION ENGINE AND API**

## Deterministic replay and evaluation
Both branches replay the same ordered intents and external observations from the same opening state. The confirmed cutoff is the only variable. Simulation results are explicitly hypothetical.
### Replay contract
Start from a snapshot before the first order. Validate unique event IDs and order inputs by UTC timestamp and fixture sequence. Replay intents, NAV publications, calendar and policy observations through the same pure dealing functions used by the order worker. Respect observation time. Use integer base units, seed-independent arithmetic and separate in-memory or isolated database state for each branch.
Record branch policy hashes, snapshot and event-log hashes, engine version, schema version and per-order trace IDs. Canonicalize JSON with sorted object keys and stable array order, then SHA-256 hash its UTF-8 bytes. Exclude model prose, timestamps of execution and run IDs from the result hash. A fixed confirmed patch must produce the same hash in the browser, local service and CLI.
| Scenario API | Success and failure behavior |
| --- | --- |
| POST /v1/scenarios/drafts | Accept fixture, baseline and input mode in the local session. Live mode takes a question. Manual mode takes typed fields and skips inference. Return 201 with proposal, clarification or unsupported state. A model timeout returns 503. |
| PATCH /v1/scenarios/{id}/draft | Accept a clarification answer or a manual edit with the expected revision. Validate, then issue a new revision and digest. Reject unknown fields (422) and stale revisions (409). Restrict access to the owning session. |
| POST /v1/scenarios/{id}/runs | Require revision, confirmation digest and Idempotency-Key. Return 202 and run ID. A changed baseline, fixture or body under a reused key returns 409. A same-key, same-body retry returns the existing run. |
| GET /v1/scenario-runs/{id} | Return queued, running, succeeded or failed. On success return both branches, deltas and trace links. Append /evidence to download a versioned comparison pack. Failed runs leave no published partial result. |
### AI release gate A09
Use 40 versioned English prompts: 20 valid paraphrases, 10 ambiguous and 10 unsupported. Record expected normalized fields or disposition and the raw classification outcome. Require at least 18/20 exact valid drafts, 10/10 ambiguity cases to ask for clarification and 10/10 unsupported cases to stay non-executable. Report model, settings, prompt version, elapsed time and individual failures.
Additionally require 100% of schema, P01 arithmetic, boundary, stale-revision, duplicate-run, timeout/fallback and isolation tests to pass. Verify identical business hashes across runtimes and zero active-policy or settlement changes. Export the captured model draft and the deterministic comparison as separate files.

**08  /  SYSTEM DESIGN**

## Architecture and settlement states
Use a TypeScript monorepo with one web app, an API and worker, a relational projection and Foundry contracts. Package the pure dealing engine for both the worker and the browser. The local model adapter has one capability: drafting a typed scenario.
| Component and owner | Authoritative responsibility | Evidence exposed |
| --- | --- | --- |
| Portfolio and partner API | Capture an intent, disclose charges, present spendable and pending positions. The browser reads and signs local demo operations. | Intent ID, quote expiry, policy reason and account statement. |
| Dealer, issuer and policy services | Serve seeded spot quotes, signed NAVs and current eligibility roots. Each role has a separate local development identity. | Signed input version, valuation date, source time and policy epoch. |
| EntryPoint, bundler and paymaster | Validate the smart account and sponsor an approved operation up to its budget. EntryPoint holds the sponsor’s native deposit. | UserOperation hash, outer transaction hash, sponsor deposit movements. |
| Spot router, fund vault and share token | Exchange spot legs atomically. Escrow, allocate or return cash and units. Enforce fund movement rules on every supported share movement. | Receipt events, cash and inventory legs, share supply and escrow balances. |
| Indexer, journal and verifier | Derive a per-asset journal from canonical events. Compare independent contract balance reads at the same block. | Block hash, finality level, ledger postings and any reconciliation difference. |
| AI Policy Lab and simulation worker | Validate and confirm a typed rule, freeze an input snapshot, then replay two branches through the shared dealing engine. Scenario storage has no settlement write credentials. | Proposal version, confirmation digest, per-order changes and a comparison manifest. |
### Two independent state fields
Business state. A spot order progresses through quoted, submitted and filled, or ends expired or declined. A fund request progresses through reserved, awaiting NAV and allocated or redeemed. A policy hold preserves escrow. Cancellation and refund are explicit events. A submitted transaction may also fail at execution.
Chain state. Record submitted, unsafe, safe and finalized independently. A later safe or finalized observation can advance a receipt. If the canonical chain replaces an unsafe block, mark its effects superseded and rebuild from the common ancestor. A blocked preflight has no transaction hash. [8]
### Account reconciliation
Journal signed movements by investor, dealer, escrow, issuer and fee recipient. Each asset balances to zero including issuance and burn control accounts. Use token transfer events for amounts and order events for attribution. Identify events by chain ID, block hash, transaction hash and log index. A restart or duplicate event creates no second business effect.
### Journal excerpt from the fund subscription
| Event | dEUR movements | eFUND movements |
| --- | --- | --- |
| Request accepted | Investor −300.00, fund escrow +300.00 | No units issued. |
| NAV applied at €96 | Fund escrow −300.00, issuer treasury +300.00 | Issuance control −3.125000, investor +3.125000. |

**09  /  ROLLUP OWNERSHIP**

## Protocol configuration and governance
Ship a local L1 consensus and execution pair, a single L2 sequencer, an L2 verifier node, a batcher, the configured proposal or dispute-game components and a canonical ETH bridge. Pin all images by digest and commit the deploy configuration. [1] [6] [9]
| Decision record | Required choice and evidence |
| --- | --- |
| ADR-01  Execution and block building | Use a supported op-reth and op-node pairing for the chosen fork. Keep the upstream block-building rules. Publish block time, gas limit, chain IDs, activation times, binary hashes and contract addresses. Document one alternative and its maintenance cost. [5] [6] |
| ADR-02  Batch submission and data availability | Publish batches in blobs for data availability (DA) on the release devnet. Link an L2 order batch to its L1 transaction and versioned blob hash. Record calldata mode separately if used in development. Publish the posting window and safety margin. [6] [19] |
| ADR-03  Finality and withdrawals | Trace one test ETH withdrawal through initiation on L2, proving on L1 and finalization on L1 after the configured proof and dispute conditions. Expose the two transaction layers and the actual delay. Any shortened timers apply only to the private devnet. [8] [9] |
| ADR-04  Authority and upgrades | Inventory the L1 upgrade administrator, sequencer, batch signer, guardian, issuer and sponsor. Use separate local signers. Rehearse a versioned policy upgrade with two-of-three approval and a test-only timelock. Record actors, activation block and a forward recovery procedure. |
### A configuration decision someone can reproduce
Compare two supported maximum channel durations, initially 4 and 12 L1 blocks, after checking both against the pinned chain’s sequencing window. Replay the same 200 orders and fixed arrival schedule three times per setting. Retain the same block time, gas limit, DA mode and fee inputs. [19]
Report p50 and p95 time from unsafe to safe, batch fill, L1 expenditure per successful order and the number of batches. Publish raw runs, hardware and commands. Choose the lower-cost setting meeting a declared 240-second p95 target. If neither meets the target, document which setting ships and the actual tradeoff.
| Two kinds of proof.  The rollup’s dispute system protects claims about L2 state used in withdrawals. The application proof establishes membership in an issuer-defined eligibility set. Record the proof configuration and verifier identity for each. [9] [20] |
| --- |

**10  /  ASSET POLICY**

## Eligibility and euro sponsorship
Separate three decisions. The issuer decides who belongs to an eligible class. The asset or dealing contract decides whether a movement may execute. The sponsor decides whether to pay for its gas.
| Control | Required behavior |
| --- | --- |
| Issuer and eligibility proof | Issue only synthetic credentials. Commit a root over eligible wallet-bound leaves. In the browser, a real Noir circuit proves membership in the current root. Bind the proof to wallet, chain ID, gate address, class, epoch and expiry. Publish the circuit, verification key hash and positive and negative vectors. [20] |
| Execution and revocation | Verify once onchain per account and epoch and cache an expiry-bound receipt. A root update invalidates earlier approvals at execution. Check both holders on transfers, the recipient on mint and the source holder on burn. Give the vault explicit custody permissions. |
| Screening and review | Use versioned synthetic screening fixtures for both parties. Managed spot and fund dealing enforce current screening. Fund units also require current class eligibility. Keep unrestricted test wrapped ETH outside this policy perimeter. Missing, stale or ambiguous inputs yield a hold or decline with a reason. |
| Sponsorship | Use a pinned EntryPoint and compatible bundler. Sign an expiring permit over normalized operation fields, sender nonce, chain, target, method and a native-cost ceiling. Check the budget and native deposit before submission. Keep validation compatible with the chosen bundler’s simulation rules. [2] [10] [11] |
### Three personas and a policy change
Verified investor. Both dealing flows proceed. Basic investor. Screening clears the spot route. Fund subscription returns ELIGIBILITY_REQUIRED before reserving cash. Flagged persona. A synthetic match blocks both managed routes. The visitor can inspect the policy version and switch back without sharing a wallet.
If eligibility changes after a fund request, hold the reserved cash and expose POLICY_CHANGED before mint. An authorized review can release a permitted refund or revalidate the order. An eligibility proof refers only to the issuer’s synthetic set at its stated epoch. Decline sponsorship independently through SPONSOR_LIMIT and leave holdings untouched.
Measure browser proving time, onchain verification gas and root-update propagation at defined checkpoints. Publish sample distributions, circuit version, hardware and browser. The public eligibility receipt is linkable to its demo wallet.

**11  /  REGULATORY CONTEXT**

## Control boundaries and data handling
Apply a distinct product policy to each instrument. The legal references identify questions a real operator would need to resolve. The sandbox implements synthetic controls and produces technical evidence.
| Reference and scope | Sandbox control and test evidence |
| --- | --- |
| MiCA, Article 2(4)(a) [13]. Financial instruments are excluded from MiCA’s scope. | Classify the two sample instruments in a versioned register. Identify issuer, right represented, transfer model and settlement asset. The fictional cash unit is a test accounting device. |
| MiFID II, Annex I, Section C(3) [14]. Units in collective investment undertakings appear in the list of financial instruments. | Model a fund-style subscription, redemption, dealing day and NAV. Use an invented issuer and price series. Actual classification, prospectus, investor eligibility and distribution permissions require case-specific review. |
| EU restrictive measures and transfer-of-funds rules [17] [18]. The applicable activities and parties determine obligations. | Record screening source version, refresh time, decision owner and review status. Demonstrate a stale list and an ambiguous case. Identify transfer-information exchange and identity checks as external dependencies for real use. |
| GDPR, Articles 5, 17 and 25 [15]. Purpose limitation, minimisation, qualified erasure rights and privacy by design. | Allow only synthetic personas. Keep credential inputs and review notes offchain. Export only typed evidence fields. Scan fixtures, logs, metrics labels and public bundles for seeded test identifiers. |
| DORA, Articles 11, 12 and 28 [16]. Response, recovery and ICT third-party risk. | Map an RPC outage, provider exit and indexer restore to a runbook, a named role and a dated drill. Retain measurements and open gaps. These artifacts support a resilience assessment. |
### Privacy and trust boundaries
The public surface contains wallet addresses, amounts, timing, public proof inputs and eligibility epochs. An observer can infer activity and possibly eligibility. Keep names, countries, account-to-person tables and private witnesses out of calldata, events, URLs and telemetry. Discard local witnesses after proving. Keep demo review notes session-local and erase them on reset.
Document who can publish a root, set a NAV, pause dealing or authorize a refund. Describe stale screening, false positives and compromised issuer authority as residual risks with owners. Link each product rule to a policy ID, applicable reference, test and limitation in the release control register.

**12  /  DEVELOPER EXPERIENCE**

## Partner API and verifiable receipts
A distributor should be able to place the same two investment orders through the API as through the UI. Publish OpenAPI, a typed TypeScript client and a runnable example in a fresh checkout.
| Endpoint | Contract and observable outcome |
| --- | --- |
| POST /v1/quotes | Accept asset, side, amount in base units and account ID. Return quote ID, price source, as-of time, expiry, charge ceiling and dealing terms. Fund requests receive an indicative NAV and assigned dealing day. |
| POST /v1/orders | Require Idempotency-Key, quote ID and account context. Return 202 plus an order ID for accepted work. Repetition with the same body returns the same order. Reuse with a different body returns 409. Persist the order and outbox record atomically. |
| GET /v1/orders/{id} | Return business state, chain state, reason code, policy epoch, money movements and trace ID. A preflight decline has no hash. An included failure has a receipt and an attributed native cost. |
| GET /v1/portfolios/{id} | Return balances as strings by asset and bucket, the data timestamp and block hash. Show marked value and price provenance. Expose stale marks and excluded holdings in the response. |
| GET /v1/runs/{id}/evidence | Download the manifest, journal, chain receipts, policy decisions and cost inputs. The SDK validates schemaVersion and content hashes before reporting a match. |
### Failure, retry and data contracts
Return 422 for an ineligible asset or expired quote and 503 with Retry-After for an unavailable dependency before acceptance. A submitted order keeps its ID through a timeout. A unique onchain order reference, durable outbox and receipt lookup prevent resubmission from producing two economic effects. A fund request blocked after acceptance retains its pending state and reason.
Define Asset, Quote, Order, NAV, PolicyDecision, Posting, ChainObservation and RunManifest schemas. Stamp UTC times, schema version and units. Bind each local order to a wallet-signed intent scoped to its quote, chain and account. Issuer and operator actions use separate role identities. The hosted replay exposes read-only data.
### Independent verification
A pack includes chain IDs, block hashes, input versions, commit, fixture seed and file digests. The offline verifier rebuilds the journal and checks the snapshot. In devnet mode it also reads contract balances at the same canonical block. Return a failing exit code and the first mismatch. The stable business digest excludes run IDs, wall-clock timings and network-dependent hashes.
### Receipt fragment from fixture G01
```json
{
  "schemaVersion": "1.0", "orderId": "G01-FUND-01",
  "businessState": "ALLOCATED", "assetId": "eFUND",
  "unitsBase": "3125000", "assetDecimals": 6,
  "cashAssetId": "dEUR", "cashDeployedBase": "300000000",
  "cashDecimals": 6, "navEurPerUnit": "96.00", "investorChargeBase": "0"
}
```

**13  /  ECONOMICS**

## What the investor pays and who bears the risk
The user sees a euro-denominated product charge before signing. The sponsor pays native currency. Instrument both sides so a developer can explain the gap on one real bundle.
| Quantity | Source and accounting rule |
| --- | --- |
| Investor charge | 0.05 dEUR for a successful spot fill and zero for fund dealing. Transfer it as an explicit leg in the same atomic spot settlement. Preflight declines and execution failures generate zero investor charge. |
| Network cost | Use measured outer-transaction receipt fields under the pinned fork. Record execution cost, applicable L1 data fee and any configured operator fee. Mark unavailable fields unknown. Store the native currency amount and timestamped demo EUR/ETH conversion. [7] |
| Sponsor cash flow | Read the actual EntryPoint settlement and paymaster deposit movements. Keep bundle-level L2 charges distinct from what the bundler recovers from the paymaster. Store any difference as a named reconciliation item. |
| Allocation to orders | Allocate shared bundle costs by measured per-operation gas with a documented residual rule. Preserve a separate bucket for failed or unattributable operations. Allocations plus residual must reproduce the bundle total in wei. |
| Chain operator economics | Compare fee-vault inflows to actual L1 batcher outflows over the same window. Show infrastructure spend separately. An L2 user data fee is distinct from the batcher’s L1 blob purchase. Count each flow once. [7] [19] |
### One transparent worked example
For an illustrative single-order bundle, €0.015 execution, €0.006 data and €0.001 operator fee total €0.022. If the sponsor actually reimburses €0.022 and collects €0.050, its contribution before overhead is €0.028. A failed included order may still cost the sponsor money. The app labels the example as modeled and replaces it with measured data in a recorded run.
### Interactive cost experiment
Offer daily order count, eligible sponsor share, ETH/EUR rate, DA price and batch utilization as explicit inputs. The default view shows the last observed run beside an editable scenario. Plot sponsor contribution per successful order and daily subsidy budget. Display “unavailable” for a missing input and the first volume or fee level at which the budget is exhausted.
### Funding and stale prices
Stop issuing new sponsorship permits if the per-operation cap or daily budget would be exceeded, the rate is more than 60 seconds old, or the deposit falls below its configured reserve. Preserve outstanding reservations until expiry. Existing fund escrow remains visible during a sponsorship pause.

**14  /  OPERATIONS**

## Service objectives and recovery drills
Expose the health of the user journey and the protocol independently. An endpoint outage, stalled sequencer and delayed NAV require different messages and recovery actions.
| Signal or drill | Trigger and action | Evidence required for release |
| --- | --- | --- |
| RPC failover | After three failed five-second probes, switch reads to an independent verifier RPC on the same chain. Verify chain ID and finalized checkpoint before resuming. | Record detection, switchover and first healthy request. Target recovery within 60 seconds in the two-node lab. |
| Batch publication | After two configured posting windows without safe-head progress during sustained load, mark finality delayed. Preserve the unsafe receipt status. | Pause and restore the lab batcher. Link head snapshots, alert, backlog clearance and resulting L1 publication. |
| Indexer restore | Restore the latest finalized checkpoint, replay canonical logs and reconcile each asset with a contract read. Refuse to promote a discrepant statement. | Compare pre- and post-restore business digests. Target a reconciled projection within five minutes for the seeded dataset. |
| NAV or policy source | At 17:00 UTC on the dealing day, wait for a signed NAV for that date. Accept a newly issued record no older than 15 minutes. Hold expired policy snapshots. | Record a delayed NAV and release it once with a valid new observation. A mismatched valuation date leaves the order waiting. |
### Operating dashboard
Show RPC p50/p95/p99 latency and errors, unsafe/safe/finalized lag, indexer lag, pending NAV age, sponsorship runway and any ledger difference. Publish time range, sample count, units and data mode. A zero-data interval shows “no samples”. Use bounded metric labels and keep wallet and order identifiers in local traces.
### Provider and ownership decisions
Evaluate two RPC profiles and one indexing or oracle alternative. Score availability and observed correctness 35%, recovery independence 25%, integration effort 15%, cost 15% and data portability 10%. Save the probes, traffic profile and weight rationale. Record unknowns explicitly and document how to change provider and replay a checkpoint.
The maintainer acts as incident lead in the exercise. The issuer owns NAV corrections and compliance review, and the protocol operator owns batch and RPC incidents. Record trigger, customer impact, timeline, recovery and follow-up. Label simulated roles and timings in the postmortem.

**15  /  VERIFICATION**

## Acceptance tests for the release
Attach each gate result to the release commit. Keep chain receipts, fixture outcomes, AI evaluation results and film checks available for independent review.
| Gate | Procedure and expected result | Artifact |
| --- | --- | --- |
| A01  Portfolio | Run G01 twice on clean seeds. Match spendable 499.95, reserved 0, tWETH 0.1 and eFUND 3.125. Redeem one unit in the independent €98 case. | golden-run.json and journal diff |
| A02  NAV and dealing | Exercise cutoff−1 second, exact cutoff, holiday, stale price, insufficient cash, dust and cancellation. Compare the assigned day, reservation and final cash movement. | dealing-cases.json |
| A03  Eligibility | Run three personas and a root rotation between request and allocation. Managed spot and every supported share movement enforce their documented rules. Assert no new units for a held order. | policy-matrix.json and proof vectors |
| A04  Account abstraction | Observe a real sponsored UserOperation, an exhausted sponsor and an included failure. Record user charge, native deposit delta and hash presence for each. | aa-receipts.json |
| A05  Chain | Prove batch publication and canonical ETH withdrawal on the private L1. Include safe/finalized head observations, chain IDs, contract addresses and configured timers. | protocol-run.json and bridge trace |
| A06  Accounting | Process duplicate input, concurrent requests against the same cash, restart and a replaced unsafe event fixture. Check per-asset conservation, reservation limits and replay equality. | invariants.json and balance audit |
| A07  Economics and operations | Reconcile a real bundle in wei. Run both batch settings and the RPC, batcher and restore drills. Publish the actual result with any missed performance target. | benchmarks/ and incident report |
| A08  Public release | Run the documented quickstart, open the replay in a clean browser, verify the downloadable pack and test the public links. Check the film against its frame and narration requirements. | release-checks.json and media/ |
| A09  AI Policy Lab | Run P01, verify both branches and repeat the confirmed comparison offline. Pass the 40-prompt evaluation and the failure, boundary and isolation tests in the simulation chapter. | policy-lab/eval.json and comparison pack |
### Test tiers and release policy
On pull requests run schema, contract, accounting, browser and offline simulation tests. On a scheduled or manual run, exercise the real model adapter and the full rollup. A release requires A01–A09 on its commit. Evidence or functional gate failures block the tag. Report misses against performance targets with a measured cause and follow-up.
Publish median and p95 for 30 proof generations and 200 API reads on named hardware, with cold and warm samples. Target p95 under five seconds for warm proving and under 500 ms for local portfolio reads. Publish language-model accuracy separately from deterministic replay correctness.

**16  /  BUILD PLAN**

## Milestones and repository structure
Plan for sixteen part-time weeks for one experienced maintainer at 15–20 hours per week. This is a delivery estimate. Use milestone exit evidence to decide when to tag the release.
| Window | Deliverable and exit decision |
| --- | --- |
| Weeks 1–2 | Define assets, calendar, UTC clock, G01 and P01. Implement cash arithmetic and a basic portfolio UI. Commit exact fixture expectations and evidence schemas. |
| Weeks 3–4 | Implement spot router, fund vault, order API, outbox and journal. Match G01 via UI and SDK. Cover sell, redemption, dust, cutoff and duplicate orders. |
| Weeks 5–6 | Build shared dealing functions, snapshot/replay, rule diffs and the two-branch result screen. Confirm P01 matches the Friday and Monday checkpoints through browser and CLI. |
| Weeks 7–8 | Connect live model adapter, implement validation and confirmation, then publish the 40-prompt evaluation. Freeze a successful draft for the public preset. Record origin and dependency-failure behavior. |
| Weeks 9–10 | Integrate EntryPoint, bundler, sponsorship, eligibility circuit and root rotation. Demonstrate a hold between fund request and issuance and benchmark the real proof. |
| Weeks 11–12 | Launch the pinned two-layer network, trace a blob batch and bridge withdrawal, and reconcile the euro charge against native cost. Publish run manifests. |
| Weeks 13–14 | Run operating drills, batch experiment and provider evaluation. Verify reorg handling, snapshot recovery and isolation. Write partner quickstart and control register. |
| Weeks 15–16 | Package the public interactive replay, scenario and settlement verifiers. Record the film on the tagged build and check the final URL. Publish all nine gate results. |
### Repository and local commands
Keep UI and HTTP endpoints in apps/web and apps/api. Put the common dealing engine in packages/dealing, provider adapter and prompt schemas in packages/policy-lab, shared SDK in packages/sdk, contracts in contracts/ and proof code in circuits/. Store frozen inputs in fixtures/ and release results in evidence/. Document pinned versions and setup in docs/.
Provide pnpm demo, pnpm devnet:up, pnpm scenario:golden, pnpm verify and pnpm devnet:down. Add pnpm policy:replay --fixture P01, pnpm policy:verify --pack <path> and pnpm policy:eval. Document the clean-checkout sequence, model download, supported hardware and cold/warm times. The recorded P01 replay must work with inference disabled.
| Delivery priorities.   Defer a hosted testnet, explorer, additional proof types and a third asset class until the settlement journey, Policy Lab and release evidence pass acceptance. |
| --- |

**17  /  REQUIRED RELEASE FILM**

## One minute demonstration with English narration
Deliver exactly 60.0 seconds with English voiceover. Record both the investor journey and the AI Policy Lab from the release build. The following 131-word script is timed for a natural read with brief pauses at the rule change and the Friday-to-Monday result.
| Time | Screen direction | English voiceover |
| --- | --- | --- |
| 00–05 | Hold the social preview. Keep the title and two asset rows legible. Begin speaking immediately. | EuroRollup shows how crypto trades and fund investments settle in euros. |
| 05–14 | Open portfolio G01. Buy €200 in test ether. Highlight the fill, five-cent fee and €799.95 spendable. | Starting with a thousand demo euros, I buy two hundred euros of test ether. The receipt shows the five-cent charge. |
| 14–22 | Reserve €300 for the bond fund. Advance the labeled clock and highlight the units issued at €96. | My fund order waits for its valuation. At ninety-six euros per unit, three hundred euros buys three and one eighth units. |
| 22–33 | Switch to Policy Lab and fixture P01. Type the Friday question. Show the parsed diff and its UTC timezone. | Now I ask what happens if Friday’s fund cutoff moves from four to three. The model turns my question into one proposed rule. |
| 33–44 | Click Confirm and compare. Focus on F-1450, then F-1530. Highlight the change from Friday to Monday. | I confirm the change and replay two orders. The earlier one still settles Friday. The three-thirty order now waits until Monday. |
| 44–55 | Highlight €300 extra reserved on Friday. Advance to Monday, show 3.125 versus 3.000 units for F-1530, and open its evidence. | That leaves three hundred extra euros reserved over the weekend. On Monday the later order receives three units. Both outcomes come with a reproducible record. |
| 55–60 | Static end card. Display the verified public GitHub URL for all 150 frames. | Open the project on GitHub and replay the experiment yourself. |
### Opening image and final card
Use the 1280 × 640 social preview on the opening frame. Fit it inside 16:9 with the project title legible. Capture the middle from Local AI mode using a genuine model-generated proposal. A cut may compress typing or generation wait time. Keep confirmation and the actual comparison visible in order.
Proposed end-card address    github.com/SergeyGer/eurorollup-settlement-lab. Use the canonical public URL when recording and verify it signed out. Keep the complete URL readable on a single line at 720p for the full final five seconds.

**18  /  PUBLICATION**

## Public demo and production checklist
A visitor should be able to watch the film, check a real settlement receipt in the recorded run, change a cutoff in the browser and reproduce the published comparison locally.
### Public application screens
| Screen | Required interaction and visual hierarchy |
| --- | --- |
| Portfolio and order ticket | Lead with spendable cash, pending commitments and holdings. Show the synthetic-data label and clock. For each asset, put price provenance, charges and settlement terms next to Confirm. |
| Receipt and policy inspector | Show the economic outcome first and put protocol details behind a disclosure. Include order, operation, transaction and batch IDs when they exist. A hold displays the reason and the next allowed action. |
| Operations and replay | Offer play, pause, previous, next and reset for G01 and the three-persona branch. Label every view Recorded replay or Local devnet. Separate modeled fee scenarios from measured figures. |
| AI Policy Lab | Expose the question, patch, confirmation and two-order diff in one guided flow. Lead with extra reserved cash and affected orders. Provide a recorded preset, manual edit, conditional live text entry and evidence export. |
### Media delivery and acceptance
Export H.264 MP4 at 1920 × 1080 and constant 30 fps with AAC audio at 48 kHz. Deliver exactly 1,800 frames. Frames 0–149 show the social preview. Frames 1,650–1,799 show the uninterrupted repository card. Carry clear English narration through the film and finish the closing line before the final frame.
Record the tagged fixture at a readable zoom. Use a short cursor halo and one focus change per action. Keep text and captions inside a 5% safe margin. Deliver an English WebVTT file and a verbatim transcript. Target about −16 LUFS integrated and at most −1 dBTP. Avoid music over numbers or the repository address.
Replay at 720p with sound muted and then with sound on. A reviewer must read the amounts and full URL, follow the order outcomes from captions, and hear intelligible speech without clipping. Attach media metadata, final-card duration, link-check result and the release commit to A08.
### GitHub release package
Put the social preview and film above the fold, followed by Try the portfolio, Run the cutoff experiment, Verify the evidence and Architecture. Publish the MP4, WebVTT, transcript, model evaluation, G01 and P01 packs with checksums and the release commit. Verify every public link signed out.
Bundle static P01 inputs, the recorded proposal and the deterministic engine for anonymous browser use. Publish an open-source license, dependency notices, compatibility manifest, quickstart, benchmark conditions and known limitations. Provide keyboard navigation and a text/table equivalent of each comparison chart.

**19  /  SOURCE REGISTER**

## Standards and reference implementations
Use the upstream sources below when implementing and documenting the protocol and regulatory boundaries. Record exact model, schema, engine, toolchain, circuit, chain fork and dependency identifiers in the release manifest.
### Open source and protocol
01   OP Stack devnet package  Portable development network and deployment parameters.
02   Account Abstraction reference implementation  EntryPoint, accounts and release tags.
03   ERC-3643 contract suite  Permissioned token design precedent.
04   Centrifuge protocol  Onchain asset management reference.
05   OP execution client retirement notice  Upstream status of the op-geth binary.
06   OP Stack protocol overview  Sequencing, execution, derivation and L1 contracts.
07   OP Stack transaction fees  Execution, data availability and operator fee components.
08   OP Stack transaction finality  Unsafe, safe and finalized heads.
09   OP Stack fault proofs  Dispute games and the withdrawal process.
10   ERC-4337  UserOperations, EntryPoint and paymaster responsibilities.
11   ERC-7562  Account abstraction validation scope.
12   ERC-7540  Reference for asynchronous vault requests and claims.
### European legal references
13   MiCA  ·  Regulation (EU) 2023/1114  Article 2 and instrument scope.
14   MiFID II  ·  Directive 2014/65/EU  Annex I, Section C(3), fund units.
15   GDPR  ·  Regulation (EU) 2016/679  Articles 5, 17 and 25.
16   DORA  ·  Regulation (EU) 2022/2554  Articles 11, 12 and 28.
17   Transfer of Funds Regulation (EU) 2023/1113  Information accompanying certain transfers.
18   EU restrictive measures and financial sanctions  Official European Commission resources.
### Implementation details
19   OP Stack batch submitter  Batch encoding, channels and publication to L1.
20   Noir documentation  Circuit tooling, public inputs and proving workflow.
