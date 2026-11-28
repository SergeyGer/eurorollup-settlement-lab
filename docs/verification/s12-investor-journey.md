# S12 verification: investor journey legibility

This record verifies audit-brief items UX-01, UX-02 and UX-03: display precision by
asset identity, a replay that starts at the seed with direct links, and receipts that
state what changed next to the evidence.

## Reproduce

```bash
pnpm build
pnpm ui:checks        # serves apps/web/dist, runs the desktop and 390 px checks
pnpm scenario:golden  # regenerated presentation strings (engine 0.2.1)
pnpm scenario:api
pnpm policy:replay
pnpm scenario:boundary
pnpm test
```

`pnpm ui:checks` writes `evidence/s12/investor-journey-checks.json` and the screenshots
under `docs/media/s12-*.png`.

## UX-01 · quantity precision by asset identity

Display precision is now a property of the asset, not of its base-unit decimals:

| Asset | Base decimals | Display decimals |
| --- | --- | --- |
| dEUR cash | 6 | 2 |
| eFUND fund units | 6 | 6 |
| tWETH test ether | 18 | 6 |

Verified values: seed €1,000.00; spot fill €799.95 spendable and 0.100000 tWETH with the
€0.05 charge; reservation €499.95 spendable and €300.00 pending; allocation
€499.95, €0.00 pending and 3.125000 eFUND. The event effect, journal movement, holdings,
receipt and allocation description all show 3.125000 (never +3.12). Canonical integer
base units stay available in the receipt's "Canonical base units and evidence" details.
The dealing engine evidence was regenerated at engine `0.2.1`; canonical integer values
are unchanged and the versioned packs record the presentation change.

## UX-02 · replay entry and direct links

- The recorded replay opens at the seed (`#replay/g01/0`) with **Start replay** and
  **View outcome** actions; Reset, the two jump actions, direct links, the browser Back
  button and the keyboard (Home = seed, End = outcome, arrows = step, Space = play) all
  address the same state.
- URLs are shareable and reloadable: `#replay/g01/2` opens the spot fill,
  `#replay/redemption/7` opens the redemption outcome.
- Switching lifecycle starts at the seed; the outcome stays one link away.

## UX-03 · receipts as useful next actions

Each receipt now shows a **What changed** strip (amount moved and reason), a
**Next event** line or final-state note, a source label (Fixture replay), a text state
badge, an evidence link beside the order ID and collapsible canonical base units with
a link to the committed evidence pack. A held fund order lists the reserved cash, the
blocking rule (authorized NAV required) and the next permissible action.

## Automated UI checks

`evidence/s12/investor-journey-checks.json` records 18 passing checks measured in
Chromium at 1440x1000 and 390x844:

| Check group | Result |
| --- | --- |
| Seed start and empty holdings | pass |
| Direct link, Start replay, View outcome, keyboard Home/End | pass |
| Ordered values: €1,000.00 → €799.95 → €499.95/€300.00 pending → €499.95/3.125000 | pass |
| Six-decimal quantity, EUR 0.05 charge, journal movement | pass |
| What-changed strip, source label, next event | pass |
| Held-order reserved cash, blocking rule, next action | pass |
| Evidence link opens canonical base units (3125000) | pass |
| 390 px: no horizontal scrolling, values and reason readable | pass |

Screenshots: `docs/media/s12-seed-desktop.png`, `s12-fill-desktop.png`,
`s12-reserved-desktop.png`, `s12-allocated-desktop.png`, `s12-receipt-evidence.png`,
`s12-mobile-allocated.png`.

## Usability pilot

The five-participant usability pilot is specified in
[`s12-usability-pilot.md`](s12-usability-pilot.md). Per the project owner's decision the
pilot is **deferred/blocked for this milestone**; the published script plus the automated
legibility checks above and the
[`accessibility checklist`](s12-accessibility-checklist.md) are accepted as the
fallback. Participant outcomes will be appended if sessions become available.
