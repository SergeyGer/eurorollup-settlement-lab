# Contributing

Thanks for taking a look at EuroRollup Settlement Lab. The project is a
synthetic-data research sandbox; contributions should preserve its
reproducibility guarantees.

## Ground rules

- All repository documentation, code comments, commit messages, issues, pull
  requests and release notes are written in English.
- Do not put current calendar dates into documentation, issues, release notes or
  the Wiki. Fixture dates and version numbers are content, not publication dates.
- Never commit credentials, API tokens, model keys or private keys. Local
  secrets live in ignored files such as `.git-token` or `.env`.
- Every behaviour change needs a deterministic test. Fixtures in `fixtures/`
  are frozen inputs; do not edit expected values to make a test pass.
- Only synthetic identities, balances and market data belong in this
  repository.

## Development workflow

1. Open or pick a GitHub Issue that describes the step and its acceptance
   criteria.
2. Create a branch, implement the change with tests and documentation.
3. Run the local checks:

   ```bash
   pnpm install
   pnpm typecheck
   pnpm test
   pnpm build
   ```

4. Open a pull request against `main`, reference the issue, and attach the
   evidence artifact or command output the issue asks for. `main` is protected:
   a pull request and a green CI run are required.
5. Close the issue only when its evidence is committed or linked, then tag a
   release for milestone-sized steps.

## Commit style

Use Conventional Commits with an issue reference:

```text
feat(dealing): implement integer cash arithmetic (#12)
docs(adr): record the batch-submission decision (#18)
```

## Determinism and evidence

- Amounts are integer base units serialized as decimal strings; never use
  floating point for money or unit counts.
- Every simulation result must be reproducible from versioned inputs: the
  canonical JSON hash excludes model prose, execution timestamps and run IDs.
- A confirmed comparison must replay identically in the browser, the local
  service and the CLI.

## Licensing

By contributing you agree that your contribution is licensed under the Apache
License 2.0 (see `LICENSE`).
