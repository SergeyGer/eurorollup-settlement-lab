# S09 verification: public replay and release packaging

This record verifies the A08 public-release checks that S09 delivers. The
machine-readable record is `evidence/a08/public-release.json`, verified offline by
`pnpm a08:verify`. The 60-second film is the remaining A08 artifact and belongs to
S10; A08 therefore stays pending in the release-check matrix.

## Public replay

<https://sergeyger.github.io/eurorollup-settlement-lab/>

The Pages workflow (`.github/workflows/pages.yml`) builds the browser app with the
project-site base path and deploys `apps/web/dist` on every push to `main`. The
recorded check fetched the URL unauthenticated (no cookies, no token) and confirmed
HTTP 200, the document title and the application mount point.

## Clean-browser check

A fresh Playwright Chromium context opened the public URL and exercised all five
views:

| View | Result |
| --- | --- |
| Recorded replay | rendered; screenshot `docs/media/s09-public-replay.jpg` |
| Local API lab | rendered (the static replay has no local API; expected connection-refused console messages are recorded separately) |
| AI Policy Lab | rendered |
| Eligibility & sponsorship | rendered; screenshot `docs/media/s09-eligibility.jpg` |
| Economics & operations | rendered; screenshot `docs/media/s09-economics.jpg` |

The browser reported no page errors and no unexpected console errors. Screenshot
digests are recorded in the evidence and re-checked by `pnpm a08:verify`.

## Quickstart and public links

Representative documented quickstart commands were run locally (`pnpm verify`,
`pnpm demo:partner`) and exited zero; the complete documented quickstart command set
is exercised by `pnpm release:checks`. The repository, Wiki and Releases links were
fetched unauthenticated and returned HTTP 200.

## Downloadable release package

`pnpm release:package` builds a deterministic source archive of the release commit
with a SHA-256 `MANIFEST.json`. For the recorded evidence the archive contained 289
manifest entries; the builder re-extracted it and every entry matched. The archive is
attached to the GitHub Release.

## Reproduce

```bash
pnpm release:package     # build and verify the downloadable package
pnpm a08:public-check    # public replay, clean browser, quickstart, links and package
pnpm a08:verify          # offline verification (also part of release:checks)
pnpm release:checks      # regenerate the A01-A09 matrix with A08 public parts
pnpm release:verify      # verify the committed matrix
```

## Recorded limitations

- A08 remains pending until the 60-second film exists; the public replay, clean-browser
  checks, public links and downloadable package are verified and recorded as passed.
- The "Local API lab" view needs a local API by design; the static replay records the
  expected local-API connection error separately instead of hiding it.
