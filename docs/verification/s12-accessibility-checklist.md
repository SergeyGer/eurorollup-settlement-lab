# S12 accessibility checklist (fallback for the deferred usability pilot)

The five-participant usability pilot is deferred by the project owner's decision
([`s12-usability-pilot.md`](s12-usability-pilot.md)). This checklist records the
automated and manual checks that stand in for the milestone, focused on the investor
journey and the replay controls.

## Automated checks (Playwright, Chromium)

Recorded in `evidence/s12/investor-journey-checks.json`; reproduce with `pnpm ui:checks`
after `pnpm build`.

| Check | Result |
| --- | --- |
| Replay controls reachable by accessible role and name (Reset, Previous, Play, Next, Start replay, View outcome) | pass |
| Keyboard navigation: ArrowLeft/ArrowRight step, Space toggles play, Home goes to the seed, End opens the outcome | pass |
| Direct-link state is stable on reload (`#replay/<mode>/<index>`) | pass |
| State badges carry a text label, not colour alone | pass — receipt badge text `FILLED`, `ALLOCATED`, `REDEEMED`; source label `Fixture replay` |
| Amounts and the pending reason are readable at 390 px without horizontal scrolling | pass (`scrollWidth 390 / innerWidth 390`) |
| Evidence details are keyboard-operable (summary/details element) and expose canonical base units | pass |
| Page title and language | `lang="en"` document, `EuroRollup Settlement Lab — portfolio replay` |

## Manual checklist

Reviewed against the built replay at 1440 px and 390 px:

- [x] Focus is visible on the replay jump buttons, controls and timeline items (browser
      default focus ring plus the button focus styling).
- [x] The receipt's colour-coded state also has the textual badge next to the panel title.
- [x] The What-changed strip names the amount, asset and reason in plain English.
- [x] The reserved-cash explanation uses words ("blocking rule", "next action") rather
      than colour alone.
- [x] No motion is required to read the state: the seven-step replay can be stepped with
      Previous/Next or the timeline buttons.
- [x] Tables fit the 390 px layout with wrapped values; no value is truncated.
- [ ] Formal WCAG contrast audit of every token — not performed; the palette is the
      existing release palette and no new low-contrast colour pairs were introduced.
- [ ] Screen-reader session with a real assistive technology — not performed; recorded
      here as an open item rather than claimed.

## Open items

- WCAG contrast audit and a screen-reader session are open follow-ups; they were not
  executed for this milestone and are not claimed as passing.
