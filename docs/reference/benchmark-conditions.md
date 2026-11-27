# Benchmark conditions

All published performance numbers were measured on the named local host with the
frozen lockfile, no container CPU limit and no concurrent workloads unless stated.

## Host

| Item | Value |
| --- | --- |
| Environment | Linux x86_64 development host used for the release evidence |
| Runtime | Node.js 22.23.3, pnpm 9.15.4 |
| Database | SQLite (Node experimental `node:sqlite`) |
| Chain | local Anvil chain for the bundle measurement; controlled OP Stack devnet for the batch drill |
| Browser | Chromium 140 via Playwright for proof generation and the film capture |

## Reproduced measurements

| Measurement | Target | Result | Command |
| --- | --- | --- | --- |
| Portfolio API reads (200 samples) | p95 < 500 ms | see `benchmarks/performance.json` | `pnpm a07:operations` |
| Warm Noir UltraHonk proof generation (30 samples) | p95 < 5 000 ms | see `benchmarks/performance.json` | `pnpm a07:operations` |
| RPC failover recovery | < 60 s | see `benchmarks/rpc-failover.json` | `pnpm a07:operations` |
| Indexer restore | < 5 min | see `benchmarks/indexer-restore.json` | `pnpm a07:operations` |
| Batch publication backlog clearance | < 120 s | see `benchmarks/batch-publication-drill.json` | `pnpm a07:batch-drill` |
| Film loudness | about -16 LUFS, at most -1 dBTP | see `media/film/film-metadata.json` | `pnpm film:build` |

## Caveats

- Numbers are single-run measurements on one host, not capacity claims.
- The local Anvil chain and the accelerated devnet clock differ from mainnet timing;
  the evidence records the acceleration and window definitions.
- Per-run details, including the exact timestamps and environment, are in the
  committed evidence files and `evidence/release-checks.json`.
