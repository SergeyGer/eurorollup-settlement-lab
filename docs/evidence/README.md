# Evidence packs and verification

An evidence pack lets an independent reviewer reproduce a released result from
versioned inputs without trusting the application database.

## What a pack contains

| Item | Contents |
| --- | --- |
| `manifest.json` | Commit, fixture seed, schema version, engine version, chain IDs, block hashes, input versions and file digests |
| `inputs/` | Frozen fixture inputs and the confirmed policy patch |
| `journal.json` | Per-asset postings derived from canonical events, attributed to investor, dealer, escrow, issuer treasury, fee recipient and issuance control accounts |
| `receipts.json` | Order and chain receipts, including chain state and native cost where available |
| `policy.json` | Policy versions, decisions, reason codes and confirmed normalized fields |
| `result.json` | Branch results, deltas and per-order changes |
| `checksums.json` | SHA-256 of every file in the pack plus the stable business digest |

## Hashing rules

- Canonical JSON: object keys sorted, array order stable, UTF-8 bytes, SHA-256.
- The stable business digest excludes model prose, execution timestamps and run
  IDs. A fixed confirmed patch reproduces the same digest in the browser, the
  local service and the CLI.
- The manifest records the schema version and the engine version so that a
  verifier can refuse a pack it does not understand.
- Chain-dependent hashes are recorded as observations and are never part of the
  stable business digest.

## Verifier

```bash
pnpm verify --pack evidence/<pack>/manifest.json
```

The verifier:

1. validates `schemaVersion` and every file digest;
2. rebuilds the journal from the frozen events;
3. recomputes the stable business digest;
4. in devnet mode, reads contract balances at the same canonical block;
5. exits non-zero and reports the first mismatch when anything disagrees.

A consumed pack is read-only: verifiers never write to it.

## Committed evidence

Released gate evidence lives under `evidence/` and is attached to the
corresponding GitHub Release:

| Path | Gate | Reproduce with |
| --- | --- | --- |
| `evidence/g01/golden-run.json` + `manifest.json` | A01 | `pnpm scenario:golden -- --check` |
| `evidence/a02/dealing-cases.json` | A02 (boundary) | `pnpm scenario:boundary -- --check` |
| `evidence/a02/api-dealing-cases.json` | A02 (API) | `pnpm scenario:api -- --check` |
| `evidence/a06/invariants.json` | A06 | `pnpm scenario:api -- --check` |

Transient local runs are written under `evidence/tmp/` (ignored) and are never
referenced by release notes.
