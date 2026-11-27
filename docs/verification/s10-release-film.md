# S10 verification: release film

This record verifies the required 60-second narrated release film and closes the
A08 gate. The machine-readable film record is `media/film/film-metadata.json`;
`pnpm a08:verify` checks it offline and `pnpm release:checks` carries A08 as passed
once the film is complete.

## Specification requirements

| Requirement | Result |
| --- | --- |
| Exactly 1800 frames at 1920×1080, constant 30 fps | 1800 frames, `r_frame_rate=30/1` |
| Exactly 60.0 seconds | 60.000 s |
| H.264 video, AAC audio at 48 kHz | `h264` / `aac`, 48 000 Hz stereo |
| Frames 0–149 show the 1280×640 social preview | static opening card, fitted inside 16:9 |
| Frames 1650–1799 show the uninterrupted repository card | static closing card, 5.0 s |
| 131-word English script, closing line before the final frame | 131 words, closing line ends before 60.0 s |
| Both journeys recorded from the release build | G01 portfolio fill/fund lifecycle and the Policy Lab P01 comparison |
| Middle segment from Local AI mode with a genuine proposal | live `qwen3:4b` Ollama proposal recorded, not the preset |
| Audio about −16 LUFS integrated, at most −1 dBTP | measured in `film-metadata.json` |
| English WebVTT and verbatim transcript | `media/film/release-film.vtt`, `media/film/release-film-transcript.md` |
| Captions inside a 5% safe margin, amounts readable | burned captions with 96 px horizontal and 60 px vertical margins |
| Repository URL readable on one line at 720p | measured at 1280×720, single line |
| Public links verified signed out | replay and repository HTTP 200 |

## Reproduce

The film build needs `ffmpeg`, a local English Piper voice, the Playwright Chromium
build, the API on `127.0.0.1:3000` with a local Ollama model, and the built browser
app on `127.0.0.1:8080`.

```bash
pnpm build && python3 -m http.server 8080 --directory apps/web/dist
MODEL_TIMEOUT_MS=45000 pnpm api
PIPER_BIN=/path/to/piper PIPER_VOICE=/path/to/en_GB-alan-medium.onnx pnpm film:build
pnpm a08:public-check   # records the signed-out public checks and film completion
pnpm a08:verify
pnpm release:checks
pnpm release:verify
```

The capture uses a 45-second model attempt deadline (the product default remains 15 s
and the 40-prompt evaluation in A09 records the default); the live proposal is genuine
model output and the capture environment is recorded in the metadata.

## Recorded media

- `media/film/release-film.mp4` — attached to the GitHub Release as
  `eurollup-release-film-1.0.0.mp4`.
- `media/film/release-film.vtt` — English WebVTT captions.
- `media/film/release-film.ass` — burned-in caption source with the safe-margin style.
- `media/film/release-film-transcript.md` — verbatim transcript.
- `media/film/social-preview-1280x640.png`, `intro-frame-1920x1080.png`,
  `end-card-1920x1080.png` — card designs.
- `media/film/film-metadata.json` — frame/audio/caption/link checks and checksums.

## Known limitations

- The film was recorded inside a headless browser at a 1.2× readable zoom; the cursor
  halo and focus highlights are injected overlays, while every state and click is the
  real release build.
- The live model journey uses the longer capture deadline described above.
- A08 passes only when the film record and every public check pass; the matrix records
  the completion on the release candidate commit.
