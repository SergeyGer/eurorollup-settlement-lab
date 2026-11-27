# Live local model adapter

The Policy Lab can draft a proposal from a short English question with a local
model runtime. The model proposes; the deterministic engine still computes every
outcome. This page documents the adapter contract, the pinned model, the failure
policy and the A09 evaluation.

## Setup

The adapter talks to a local [Ollama](https://ollama.com) runtime on
`http://127.0.0.1:11434` (override with `OLLAMA_BASE_URL`). Install Ollama, then:

```bash
ollama serve
ollama pull qwen3:4b
pnpm policy:model:status
```

The pinned model for release 1.0 is `qwen3:4b`. Its content digest is recorded in
the evaluation evidence and in the captured live draft; the model identifier and
digest travel with the proposal. `OLLAMA_MODEL` overrides the model for local
experiments, but the committed evaluation always records the model it actually
used.

## Adapter contract

- One structured response per attempt. The runtime is asked for a JSON object
  constrained by the proposal decoding schema; the adapter re-validates the
  parsed object against the full proposal schema, including
  `additionalProperties: false`.
- On malformed output the adapter retries once with schema feedback. A second
  failure, a configured 15-second deadline per attempt, or an unreachable runtime
  returns a recoverable error (`MODEL_OUTPUT_INVALID`, `MODEL_TIMEOUT`,
  `MODEL_UNAVAILABLE`). The API surfaces these as `503` with `Retry-After`.
- A failed free-text request is never silently replaced by the recorded preset.
  The recorded preset and the manual editor stay available.
- The proposal cannot carry settlement outcomes: it is one typed rule change.
  Numbers come only from the deterministic replay after confirmation.
- The adapter receives synthetic rule metadata and the short question. It has no
  signing keys, shell tools, chain RPC methods or portfolio write access.
- Raw free text stays session-local: live drafts are persisted with the question
  field empty, while the response to the owning session carries the text.
- The first live request pays a one-time model and prompt-prefix warm-up; the
  adapter reports the model metadata with each draft.

### Prompt and decoding

- Prompt version `p01-live-v10`, temperature `0`, seed `42`, context 4096,
  generation budget 120 tokens.
- The prompt contains a compact decision procedure (unsupported → clarify →
  proposed), the supported-rule facts, the current rule and fixture context, and
  short multi-turn examples.
- The decoding schema constrains the status and field enums and forbids
  additional properties; the adapter strips nothing except an explicitly
  tolerated code fence. The typed proposal that reaches confirmation is fully
  validated.

## Failure behaviour

| Situation | Adapter result | API response |
| --- | --- | --- |
| Malformed JSON / schema violation | retry once with schema feedback | — |
| Second malformed output | `MODEL_OUTPUT_INVALID` | `503` + `Retry-After: 30` |
| No answer within 15 s per attempt | `MODEL_TIMEOUT` | `503` + `Retry-After: 30` |
| Runtime unreachable or model missing | `MODEL_UNAVAILABLE` | `503` + `Retry-After: 30` |
| Valid structured output | typed proposal + model metadata | `201` draft |

The UI keeps the recorded preset and the manual editor usable in all failure
states.

## A09 evaluation

`pnpm policy:eval` runs the versioned 40-prompt fixture
(`fixtures/policy-lab/eval-prompts.json`) through the live adapter and writes
`evidence/policy-lab/eval.json`:

- 20 valid paraphrases with expected normalized fields;
- 10 ambiguous requests that must produce a clarification, never an executable
  change;
- 10 unsupported requests that must stay non-executable.

Thresholds: at least 18/20 exact valid drafts, 10/10 clarifications and 10/10
non-executable unsupported requests. The report records the model, digest,
temperature, seed, context, generation budget, timeout, prompt version, elapsed
time per prompt and every failure. Exactness is defined over the required
normalized fields; the optional stated-prior-time field is checked for
consistency when present.

`pnpm policy:eval -- --verify-only` validates the committed report structure and
thresholds without a runtime; CI uses it. `pnpm policy:eval -- --adapter mock`
exercises the harness with a scripted model in CI.

## Recorded live capture

`pnpm policy:record` asks the live adapter the recorded P01 question, stores the
genuine proposal in `fixtures/policy-lab/p01-recorded-proposal.json` (labelled
recorded live-model output with model, digest, prompt version and raw output) and
writes `evidence/policy-lab/live-model-draft.json`. The deterministic comparison
is exported separately as `evidence/policy-lab/p01-comparison.json`, so the
model draft and the computed comparison never share a file.

The browser AI Policy Lab shows the recorded capture as the "Recorded proposal"
preset and labels live-model drafts as "Live model"; manual edits stay labelled
with their parent revision.

## Known limitations

- The adapter is CPU-oriented and single-request; concurrent browser requests
  share the local runtime queue.
- The compact model is not a guarantee of correctness: malformed or ambiguous
  output is rejected by the contract, never repaired into an executable change.
- Only the single supported rule (one weekday's weekly eFUND subscription
  cutoff) can be drafted; anything else must be unsupported or clarified.
