# Verification — step S04 (live local model adapter)

This page records the verification evidence for development step S04: the working
local inference adapter, the confirmation boundary, the recorded live capture and
the 40-prompt A09 evaluation. Results are attached to the GitHub release
`v0.4.0`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm scenario:golden -- --check
pnpm scenario:boundary -- --check
pnpm scenario:api -- --check
pnpm api:openapi -- --check
pnpm policy:replay -- --check
pnpm policy:verify
pnpm policy:eval -- --adapter mock
pnpm policy:eval -- --verify-only
pnpm verify
pnpm demo:partner
```

The live-model commands need a local runtime:

```bash
ollama serve
ollama pull qwen3:4b
pnpm policy:model:status
pnpm policy:eval
pnpm policy:record
```

## Pinned model and adapter

| Item | Value |
| --- | --- |
| Runtime | local Ollama (`http://127.0.0.1:11434`) |
| Pinned model | `qwen3:4b` |
| Model content digest | recorded in `evidence/policy-lab/eval.json` and `live-model-draft.json` |
| Prompt version | `p01-live-v10` |
| Temperature / seed | `0` / `42` |
| Context / generation budget | 4096 tokens / 120 tokens |
| Attempt deadline | 15 s per attempt, one retry with schema feedback |
| Structured output | proposal decoding schema (status and field enums, no additional properties) |

The adapter process has one capability: drafting a typed proposal from synthetic
rule metadata and a short question. It has no signing keys, shell tools, chain RPC
methods or portfolio write access. Parsed output is validated against the full
proposal schema before it can become a draft; a failed call never falls back to
the recorded preset.

## A09 evaluation — 40 prompts

`pnpm policy:eval` writes `evidence/policy-lab/eval.json`. The report records the
model, digest, temperature, seed, context, generation budget, timeout, prompt
version, per-prompt elapsed time and every failure.

| Category | Requirement | Result |
| --- | --- | --- |
| Valid paraphrases — exact normalized draft | at least 18/20 | 20/20 |
| Ambiguous requests — clarification, never executable | 10/10 | 10/10 |
| Unsupported requests — non-executable | 10/10 | 10/10 |
| Model errors | — | 0 |

Exactness is defined over the required normalized fields (`status`, `operation`,
`asset`, `weekday`, `timeUtc`, `timezone`); the optional stated-prior-time field
is checked for consistency when present. Each ambiguous prompt produced a
clarification question with the missing fields; each unsupported prompt produced
a non-executable disposition with a reason code.

Coverage includes natural paraphrases ("the bond fund", "dealing cutoff",
"one hour earlier", 12-hour clocks, times across the valid range), genuinely
ambiguous requests (no weekday, no new time, relative-only wording, local time,
CET) and fixed-rule requests (redemption, NAV publication, fees, another asset,
several weekdays, recurring schedules, weekend days, out-of-range times).

`pnpm policy:eval -- --verify-only` re-validates the committed report structure
and thresholds without a runtime; CI runs it. `pnpm policy:eval -- --adapter
mock` exercises the harness with a scripted model in CI.

Adapters tests (`packages/policy-lab/test/live-model.test.ts`) cover:

- structured output parsing, code fences and rejection of additional fields;
- one retry with schema feedback after malformed output;
- recoverable `MODEL_OUTPUT_INVALID` after two malformed attempts;
- retry after a timeout and recoverable `MODEL_TIMEOUT`;
- `MODEL_UNAVAILABLE` without a preset fallback;
- a perfect scripted model passing the evaluation and a drifting model failing it;
- structural verification of a committed report.

API tests (`apps/api/test/model-live.test.ts`) cover:

- a live-origin draft with model metadata in the response;
- raw free text kept out of persisted draft revisions;
- one retry with schema feedback;
- recoverable `MODEL_OUTPUT_INVALID` with `Retry-After`;
- recoverable `MODEL_TIMEOUT` with no scenario row created;
- `MODEL_UNAVAILABLE` while recorded and manual modes stay usable;
- empty and oversized questions rejected before the model call;
- `GET /v1/model/status`; the scenario paths in the generated OpenAPI document;
- no settlement or policy state change when a live draft is created.

## Recorded live capture

`pnpm policy:record` captured a genuine proposal from the live adapter for the P01
question and stored it as the recorded preset:

- `fixtures/policy-lab/p01-recorded-proposal.json` — proposal plus capture
  metadata (provider, model, digest, prompt version, temperature, seed, attempts,
  elapsed time, raw output);
- `evidence/policy-lab/live-model-draft.json` — captured live draft with draft and
  confirmation digests.

The deterministic comparison is exported separately as
`evidence/policy-lab/p01-comparison.json`. Digests and numbers are unchanged by
the model capture because the model never computes outcomes.

## Browser live mode

The AI Policy Lab has three input modes: recorded proposal, manual edit and live
local model. Live mode sends the short question through the scenario API, shows
the origin and model metadata in the review state, then computes both branches
locally after confirmation. Failure states keep the recorded preset and manual
editor available; the first live request pays a one-time model warm-up.

Screenshot: `docs/media/s04-policy-lab-live.jpg`.

## Known limitations

- The adapter is CPU-oriented and single-request; concurrent requests share the
  local runtime queue.
- The compact model is not guaranteed correct: invalid output is rejected, not
  repaired into an executable change.
- Model output is non-deterministic in principle; the committed evaluation
  records one reproducible run with temperature 0 and a fixed seed, and the
  deterministic comparison digests never depend on the model.
