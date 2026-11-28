# S12 usability pilot: investor journey

Audit-brief UX-03 asks for a five-participant test script with actual outcomes and a
target of at least four of five unaided completions on the investor task. This page
publishes the script and the recording template. **Status: deferred by the project
owner's decision** — the pilot is recorded as blocked and the published script plus the
automated legibility/accessibility checks are accepted as the milestone fallback. No
participant outcomes are claimed.

## Participants and setup

- Five people unfamiliar with the project; record only synthetic test data.
- Environment: desktop browser at a 1440-wide window and, for one task, a 390 px
  mobile-width window (or a phone). The public replay is enough; no account, wallet or
  model key is needed.
- Moderator reads the tasks verbatim and does not point at the screen unless the
  participant is stuck for more than 60 seconds; record unaided completion, first error
  and time to completion.

## Tasks and questions

1. **Spendable cash** — "You have demo euros. How much can you spend right now, and how
   much is waiting for a valuation?" Record the answer, the clicked element and whether
   the participant found the pending amount without help.
2. **Why the fund is pending** — "Why has the fund order not received units yet, and
   what has to happen next?" Record the explanation, the blocking rule found and any
   confusion between reserved cash and spendable cash.
3. **Affected cutoff order** — "Change the Friday eFUND subscription cutoff to 15:00 UTC
   in the Policy Lab and find which order changes settlement day and by how much."
   Record whether the participant found F-1530, the Monday date, 3.000000 units and the
   €300.00 extra reserved.
4. **Receipt follow-up** — "Open a receipt and find what changed and where the evidence
   is." Record whether the What-changed strip, next event and evidence link were found.
5. **Mobile legibility** — Repeat tasks 1 and 2 at 390 px width. Record any horizontal
   scrolling, truncated values or unreadable labels.

## Scoring

| Measure | Target |
| --- | --- |
| Unaided completions of the investor task (tasks 1–3) | at least 4 of 5 participants |
| Errors per question | recorded and ranked; the most common failure is fixed before the film re-cut |
| Time to locate spendable/pending cash | recorded (no hard target) |
| Mobile horizontal scroll or unreadable value | zero occurrences |

## Recording template

```
Participant: P1..P5
Task 1: complete / partial / failed | time | first error | observation
Task 2: complete / partial / failed | time | first error | observation
Task 3: complete / partial / failed | time | first error | observation
Task 4: complete / partial / failed | time | first error | observation
Task 5: pass / fail (horizontal scrolling, truncation) | observation
Most common failure: <ranked list>
Fix applied before filming: <change + issue/commit>
```

## Deferred status and fallback

The project owner selected fallback option (b) for this milestone: the pilot is recorded
as **blocked/deferred** rather than claimed as run. The published artefact is this script
plus the automated checks:

- 18/18 investor-journey UI checks at 1440x1000 and 390x844
  (`evidence/s12/investor-journey-checks.json`), including keyboard Home/End/arrow/Space
  navigation, direct links, six-decimal quantities and 390 px no-horizontal-scroll.
- The accessibility checklist in [`s12-accessibility-checklist.md`](s12-accessibility-checklist.md).

When five participant sessions become available, the outcomes are appended to this page,
the most common failure is fixed before the film re-cut, and the counts are reported in
the issue. Until then the milestone records the fallback explicitly.
