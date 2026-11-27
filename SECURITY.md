# Security Policy

## Scope

EuroRollup Settlement Lab is a synthetic-data research sandbox. It is not a
production settlement system and holds no real funds, real identities or real
market data. The following are still treated as security issues:

- committed credentials, tokens or private keys;
- dependency vulnerabilities and malicious packages;
- supply-chain or workflow compromise in CI;
- privilege or role-separation defects between issuer, operator and sponsor
  responsibilities inside the demo;
- evidence-integrity defects, such as a comparison pack that cannot be
  reproduced or a verifier that accepts a mismatched hash.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub
private vulnerability reporting from the repository **Security** tab
("Report a vulnerability") so the report stays private until a fix is
available.

Include the affected component, the release tag or commit, reproduction steps
and the expected versus actual behaviour. You should receive an
acknowledgement within five business days. Confirmed issues are fixed on `main`,
assigned a GitHub Security Advisory where appropriate, and referenced in the
next release notes.

## Supported versions

Security fixes are applied to the latest release line and to `main`. Older
development tags are not maintained.

## Repository security controls

- Branch protection on `main`: pull requests, required CI status checks, linear
  history, no force pushes, no branch deletion.
- Dependabot alerts and Dependabot security updates enabled.
- Dependabot malware alerts enabled where the platform exposes the setting.
- Secret scanning and push protection enabled for the repository.
- Private vulnerability reporting enabled.
- Local credentials (for example the maintainer's `.git-token`) are excluded by
  `.gitignore`; run `git status` before pushing and never commit a token.
- The demo model adapter runs without signing keys, RPC write methods or
  portfolio write access.

## Out of scope

- Findings that rely on the documented synthetic nature of the data (for
  example, invented balances or fabricated personas).
- Denial-of-service against a locally hosted development run.
- Issues in third-party reference implementations that the project only cites.
