# S14 verification: release film re-cut and accessible playback

This record verifies the presentation re-cut of the release film (audit brief §08–§10,
FILM-00/01/02) and the accessible browser player. A08 remains passed with the updated
film metadata.

## Re-cut compliance

| Requirement | Result |
| --- | --- |
| Exactly 1800 frames at 1920×1080, constant 30 fps | 1800 frames, `r_frame_rate=30/1` |
| Exactly 60.0 s, H.264 video + AAC 48 kHz stereo | 60.000 s, `h264`/`aac` 48 000 Hz, 2 ch |
| Opening frames 0–149 use the owner-approved C2 artwork | yes — 1728×864 sharp artwork inside a blurred extension of the same artwork, title/key elements inside the 5% safe area |
| Captions never burned into frames | yes — no burned-in caption source exists; English WebVTT delivered as a separate track |
| Full-frame end card, frames 1650–1799 | artwork to every edge, title upper third, repository URL on the optical centre, settlement artwork visible through the lower third, 5.0 s static hold |
| Repository URL readable at 720p and phone width | 1001 px wide at 720p, 305 px at phone scale, one line, inside the safe area |
| 131-word English script, closing line before final frame | 131 words; closing line ends before 60.0 s |
| Loudness | −15.8 LUFS integrated, −2.1 dBTP true peak |
| Clean captures, no state hidden before its narration | seed €1,000 → fill €799.95 + €0.05; €300 reserved → 3.125000 units; question entering → typed proposal; confirm → F-1530 Monday; €300 extra/72 h → 3.000000 units; comparison evidence opened |

Evidence: `media/film/film-metadata.json` (checks, digests, composition notes) and
`media/film/checksums.txt`. Reproduce with `pnpm film:build` (needs ffmpeg, Piper,
Playwright Chromium, the local API with Ollama and a served web build).

## Approved artwork on every surface

The owner-approved C2 artwork is used for the README poster, the Pages social image, the
Wiki film page, the film opening frames and the repository Social Preview. `pnpm check:social`
verifies the uploaded repository social preview against the approved digest
(`evidence/rel/social-preview.json`).

## Accessible playback (`pnpm check:film`)

The browser replay has a **Release film** view that streams the release MP4; the English
WebVTT track is separate, captions start **off** and a toggle switches them on/off. The
transcript, MP4 download, release notes and the repository address sit beside the player.

`evidence/s14/playback-checks.json` records automated checks signed out on desktop
(1440×1000) and phone (390×844): 20/20 pass — video element and MP4 source, separate
English caption track, initial hidden mode, toggle on and off, metadata duration 60 s,
seek to 45 s, muted playback advancing, transcript/download links and the repository
address. Screenshots: `docs/media/s14-player-desktop.png`, `s14-player-phone.png`.

Automation note: the bundled headless Chromium cannot decode H.264, so the decode/seek
control checks run against a VP9 test transcode of the same film; the published MP4 is
validated by ffprobe/film metadata. The public Pages player is re-checked against the live
`v1.1.0` asset with `PLAYBACK_SKIP_DECODE=1`: structure, caption track and toggle, poster
digest, transcript/download links, repository address and a signed-out HTTP 200 for the
8,376,057-byte MP4 are recorded in the same evidence file. A human listening pass on
speakers and a phone was **not** performed in this environment and is recorded as an open
item rather than claimed.
