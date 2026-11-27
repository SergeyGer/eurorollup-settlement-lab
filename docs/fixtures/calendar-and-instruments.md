# Calendar and instruments

## Instruments

| Asset | Kind | Decimals | Lane | Notes |
| --- | --- | --- | --- | --- |
| dEUR | Demo euro cash | 6 | Cash leg | Test accounting device; not a real e-money token |
| tWETH | Test wrapped ETH | 18 | Spot | Unrestricted synthetic test wrapped ETH outside the eligibility perimeter |
| eFUND | Fictional euro short-duration bond fund unit | 6 | Fund | Issuer-defined eligibility class; subscription, redemption and NAV lifecycle |

All amounts are integer base units. External interfaces serialize them as
decimal strings; internal arithmetic never uses floating point.

## Calendar `LAB-UTC-1`

- Timezone: UTC. All times displayed and computed in UTC, with an explicit UTC
  label in the UI.
- Dealing days: Monday to Friday, except dates listed as closed in the calendar
  fixture.
- Weekend: Saturday and Sunday are closed.
- Fixture days:

| Date | Status |
| --- | --- |
| Friday 20 November 2026 | Dealing day |
| Saturday 21 November 2026 | Closed |
| Sunday 22 November 2026 | Closed |
| Monday 23 November 2026 | Dealing day |

- An order requested strictly before the subscription cutoff enters the current
  dealing day's batch. At or after the cutoff, at weekends and on fixture
  holidays it moves to the next dealing day.
- The calendar is versioned (`LAB-UTC-1`); changing a holiday or a dealing day
  produces a new version so that a saved comparison cannot silently change.

## NAV observations

A NAV observation names the asset, valuation date, value, source time, a
signer identity and a revision. A corrected NAV carries a separate revision and
an adjustment event; settled entries stay auditable. A NAV observation for a
different valuation date does not satisfy a waiting order.

## Price freshness

- Spot quote price sources are refused if older than 60 seconds.
- The demo EUR/ETH conversion used for cost reporting is refused if older than
  60 seconds.
- A waiting fund order accepts a newly issued NAV record no older than 15
  minutes for its valuation date.
