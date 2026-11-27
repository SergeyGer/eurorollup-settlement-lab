## Summary

<!-- What does this pull request change and why? -->

Closes #<!-- issue number -->

## Scope

- [ ] Code changes are limited to the issue scope
- [ ] Fixtures and expected values are unchanged (or explained below)
- [ ] Documentation and/or Wiki updated where behaviour changed

## Evidence

<!-- Paste commands, test output, hashes or artifact links. -->

```text
pnpm typecheck
pnpm test
pnpm build
```

## Checklist

- [ ] Amounts remain integer base units; no floating-point money arithmetic
- [ ] Deterministic replay or hash checks cover the change
- [ ] No credentials, tokens or private keys added
- [ ] No current calendar dates added to repository documentation
- [ ] Documentation written in English
