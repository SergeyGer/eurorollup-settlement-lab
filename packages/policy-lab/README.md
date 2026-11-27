# AI Policy Lab engine

The deterministic Policy Lab: one typed rule change, two settlement branches and
reproducible evidence.

This package is shared by the browser Policy Lab view, the scenario API and the
CLI evidence runner. Because all three import the same code and the same frozen
fixtures, a confirmed patch reproduces the same comparison digest everywhere.

## What it provides

- Server-owned draft derivation: baseline policy version and hash, fixture hash,
  calendar hash, revision and confirmation digest.
- Revisioned edits with parent links.
- A discriminated proposal JSON Schema (`proposed`, `clarify`, `unsupported`)
  with `additionalProperties: false`, documented enums and a 500-character text
  limit, plus a hand-rolled validator that runs in the browser.
- The P01 two-branch replay: identical ordered intents and NAV observations,
  isolated branch state, per-branch policy and event-log hashes, per-order
  results and Friday/Monday portfolio snapshots.
- Boundary replay cases (cutoff instants, closed Monday, missing NAV).
- The P01 evidence pack and its canonical digests.

## Commands

From the repository root:

```bash
pnpm policy:replay            # write evidence/policy-lab/p01-comparison.json
pnpm policy:replay -- --check # verify the committed bytes
pnpm policy:verify            # verify file digests, comparison digest and replay
```

## Related documentation

- `docs/policy-lab/p01-friday-cutoff.md` — the experiment and its result.
- `docs/verification/s03-policy-lab.md` — verification record.
- `docs/api/partner-api.md` — scenario API surface.
