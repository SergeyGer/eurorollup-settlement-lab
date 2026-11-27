# Known limitations

The sandbox is a synthetic-data research and demonstration environment, not a
production settlement system. The following limitations are known and recorded in
the evidence instead of being hidden.

## Settlement and chain

- The controlled local OP Stack devnet uses an execution-only local L1 with a
  synthetic two-second block clock. L1 consensus finality is not modelled; L2
  safe/finalized heads from op-node and the L1 head are recorded instead.
- Batch publication is demonstrated in calldata development mode. Blob data
  availability (EIP-4844) is not demonstrated on the local lane; the consensus-backed
  Kurtosis lane is blocked by an upstream image/genesis mismatch. Follow-ups are
  recorded in the A05 records and the release-check matrix.
- The portal timers are satisfied on the local clock with recorded `evm_increaseTime`
  accelerations; they are not wall-clock waits.
- Assets, balances, prices, calendars and identities are synthetic fixtures. No real
  funds, securities or personal data are involved.

## Economics

- The measured bundle runs on a plain Anvil chain, so the OP-stack L1 data fee and
  operator fee are unavailable and recorded as `null`, not estimated.
- The EUR/ETH conversion used in the browser cost experiment is a timestamped demo
  fixture, not a live market rate.
- Provider evaluation and operating drills use local fixture servers and the
  deterministic balance oracle rather than production providers; the evaluation
  records these unknowns explicitly.

## AI Policy Lab

- The local model adapter supports one capability — drafting a typed proposal from
  synthetic rule metadata. A failed or timed-out model call never silently falls
  back to the recorded preset; the browser exposes the recorded preset and manual
  editor instead.
- The film capture used a 45-second model attempt deadline because the local 4B
  model on the capture host can exceed the product default of 15 s. The product
  default and its evaluation are recorded in A09 evidence.
- The model only proposes the typed change; outcomes are computed by the
  deterministic engine after explicit confirmation.

## Release and media

- The public replay runs entirely on frozen fixtures; the local API lab view needs a
  locally running API and shows an expected connection error otherwise.
- The film was recorded inside a headless browser at a 1.2x readable zoom; the cursor
  halo and focus highlights are injected overlays while every state and click is the
  real release build.
- Performance figures are host-specific (named host and conditions in
  `docs/reference/benchmark-conditions.md`), not capacity commitments.

## Security and compliance

- No external audit, penetration test or regulatory review is claimed.
- The repository, release and Wiki publish synthetic data only; no production
  credentials are included.
