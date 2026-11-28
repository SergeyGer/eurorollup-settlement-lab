# S13 verification: publication commands, portability and release attestation

This page records the S13 publication fixes that do not depend on the new artwork:
verified commands and aliases, the LF line-ending policy, the REL-01 release attestation
and the signed-out link check. The README first-screen restructure and the Wiki map wait
for the owner-approved Social Preview and remain open in #48.

## Reproduce

```bash
pnpm verify --pack evidence/g01                  # pack directory
pnpm verify --pack evidence/g01/manifest.json    # manifest file path now works too
pnpm demo                                        # alias of pnpm demo:partner
pnpm devnet:up && pnpm devnet:down               # aliases of the local devnet scripts
pnpm check:line-endings                          # REL-02 line-ending evidence
pnpm release:attest && pnpm release:attest:verify # REL-01 release attestation
pnpm check:links                                 # relative links + signed-out public URLs
```

## Commands and aliases

- `pnpm verify --pack` accepts both a pack directory and its `manifest.json`; the Wiki
  example that previously failed with a manifest path now works.
- `pnpm demo`, `pnpm devnet:up` and `pnpm devnet:down` are aliases beside the existing
  `demo:partner`, `devnet:local:up` and `devnet:local:down` commands.
- The `.gitignore` pattern only ignores the top-level build-output `/release/` directory,
  so `docs/release/README.md` is tracked again; the unresolved architecture link and the
  docs/release image paths were corrected.

## REL-02 · line endings and portability

`evidence/rel/line-endings.json` records:

| Check | Result |
| --- | --- |
| `.gitattributes` policy present | yes (pins LF for `evidence/**`, `schemas/**`, `fixtures/**`, docs/tooling text; binary assets marked) |
| Tracked files scanned | 348 (`312` text LF, `36` binary) |
| Index CRLF/mixed offenders | 0 |
| Worktree CRLF/mixed offenders | 0 |
| Hashed attribute samples (`evidence/**`, `schemas/**`, `fixtures/**`, film VTT) | `text: set`, `eol: lf` |
| Simulated Windows checkout (`core.autocrlf=true`, `core.eol=crlf`) | `evidence/g01/golden-run.json` stays LF, 25,886 bytes, SHA-256 identical |
| Repository renormalisation | no tracked content changed |

Native Windows was not available on this host; the simulation and attribute policy are
recorded instead of claiming a native run. Byte verification remains strict.

## REL-01 · release attestation

`evidence/release-attestation.json` records the v1.0.0 relationship:

| Field | Value |
| --- | --- |
| Publication tag / commit | `v1.0.0` / `9dbe565e` |
| Build commit (`builtFromCommit`) | `cb982837` |
| Difference | four evidence/metadata files only: `evidence/a08/public-release.json`, `evidence/a08/release-package.json`, `evidence/release-checks.json`, `media/film/film-metadata.json` |
| Archive | `eurollup-settlement-lab-1.0.0.tar.gz`, SHA-256 `ee79d38389af…`, `exactTaggedTree: false` |
| Film | `eurollup-release-film-1.0.0.mp4`, SHA-256 `0af81effc863…` |
| Captions / transcript digests | match the committed film metadata |

The earlier-source archive is no longer described as the exact tagged tree; the four-file
diff and both commits are recorded. `pnpm release:attest:verify` runs in CI (full-history
checkout) and refuses a mismatch.

## Link check

`evidence/rel/link-check.json`: 62 checks, 53 relative files and 9 signed-out public URLs
(replay, repository, release page, film/VTT/archive/release-check assets, Wiki home and
the film page); **0 failures**.

## Owner-approved artwork

Revision **C2** was approved by the project owner (recorded in #46) and is now the
canonical artwork at `media/social-preview/approved-1280x640.png` (SHA-256
`1b56f8f9…`). It is used for the README first-screen poster, the GitHub Pages
`apps/web/public/social-preview.png` social image and the Wiki film page; the film
opening shot uses the same artwork in the S14 re-cut.

## Signed-out publication sessions

`pnpm check:sessions` opens the public surfaces without cookies or tokens and writes
`evidence/rel/publication-sessions.json` plus the screenshots:

| Session | Result |
| --- | --- |
| README desktop 1440x1000 signed out | film, replay, cutoff experiment, receipt and Wiki actions above the fixture content; approved poster visible (1280 px natural width) |
| README phone 390x844 signed out | same one-click actions and approved poster readable |
| Wiki home desktop signed out | release 1.0.0 status current; film page reachable |

Screenshots: `docs/media/s13-readme-desktop.png`, `s13-readme-phone.png`,
`s13-wiki-home.png`.

## Remaining manual step

The GitHub **repository Social Preview** setting has no public API. The approved 1280x640
PNG (`media/social-preview/approved-1280x640.png`, SHA-256 `1b56f8f9…`) is ready for the
repository owner to upload in Settings; every repository-controlled surface already uses
it. This is tracked in #46.

## Remaining S13 work

None: the README first screen, the Wiki map, the command/link fixes, the portability and
attestation checks and the signed-out sessions are complete. The Wiki page map itself is
maintained in the Wiki repository.
