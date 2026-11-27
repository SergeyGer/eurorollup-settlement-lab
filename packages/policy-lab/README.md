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
- The live local model adapter: Ollama HTTP port, schema-constrained decoding,
  one retry with schema feedback, recoverable timeout/unavailable errors and a
  40-prompt evaluation harness with a committed report.
- Recorded live capture and scripted model ports for deterministic tests.

## Commands

From the repository root:

```bash
pnpm policy:replay            # write evidence/policy-lab/p01-comparison.json
pnpm policy:replay -- --check # verify the committed bytes
pnpm policy:verify            # verify file digests, comparison digest and replay
pnpm policy:eval              # 40-prompt evaluation against the local model
pnpm policy:eval -- --verify-only  # validate the committed evaluation report
pnpm policy:record            # capture a genuine live proposal as the preset
pnpm policy:model:status      # local runtime and pinned model status
```

## Related documentation

- `docs/policy-lab/p01-friday-cutoff.md` — the experiment and its result.
- `docs/verification/s03-policy-lab.md` — verification record for the deterministic comparison.
- `docs/verification/s04-live-model.md` — verification record for the live adapter.
- `docs/policy-lab/live-model-adapter.md` — adapter contract, failure policy and evaluation.
- `docs/api/partner-api.md` — scenario API surface.
