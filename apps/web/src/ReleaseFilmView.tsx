/**
 * Release film view.
 *
 * Streams the published release cut with the English WebVTT captions delivered as a
 * separate track: captions start off and can be switched on. The verbatim transcript
 * and the MP4 download are one click away, and the repository address stays visible
 * beside the player. Nothing is burned into the video frames.
 */
import { useEffect, useRef, useState } from "react";

const REPOSITORY_URL = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;
const FILM_URL =
  (import.meta.env.VITE_FILM_URL as string | undefined) ??
  `${RELEASES_URL}/download/v1.1.0/eurollup-release-film-1.1.0.mp4`;
const baseUrl = import.meta.env.BASE_URL;
const CAPTIONS_URL = `${baseUrl}release-film.vtt`;
const TRANSCRIPT_URL = `${baseUrl}release-film-transcript.md`;
const POSTER_URL = `${baseUrl}social-preview.png`;

export function ReleaseFilmView(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const track = video.textTracks[0];
    if (track !== undefined) {
      track.mode = captionsOn ? "showing" : "hidden";
    }
  }, [captionsOn]);

  useEffect(() => {
    if (!transcriptOpen || transcript !== null) return;
    let cancelled = false;
    fetch(TRANSCRIPT_URL)
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => {
        if (!cancelled && text !== null) setTranscript(text);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [transcriptOpen, transcript]);

  return (
    <section className="film-view">
      <div className="panel film-player">
        <div className="panel-head">
          <h2>Release film</h2>
          <span className="fixture-tag">60 seconds · English narration</span>
        </div>
        <video
          ref={videoRef}
          className="film-video"
          controls
          preload="metadata"
          poster={POSTER_URL}
          aria-label="EuroRollup Settlement Lab 60-second release film"
        >
          <source src={FILM_URL} type="video/mp4" />
          <track kind="captions" src={CAPTIONS_URL} srcLang="en" label="English captions" default={false} />
          Your browser does not support the video element. The MP4 is available from the releases page.
        </video>
        <div className="film-actions">
          <button
            type="button"
            className={`jump-button ${captionsOn ? "active" : ""}`}
            aria-pressed={captionsOn}
            onClick={() => setCaptionsOn((current) => !current)}
          >
            Captions {captionsOn ? "on" : "off"}
          </button>
          <a className="film-action-link" href={TRANSCRIPT_URL}>
            Transcript
          </a>
          <a className="film-action-link" href={FILM_URL}>
            Download MP4
          </a>
          <a className="film-action-link" href={RELEASES_URL}>
            Release notes
          </a>
        </div>
        <p className="film-url">
          Repository:{" "}
          <a href={REPOSITORY_URL}>github.com/SergeyGer/eurorollup-settlement-lab</a>
        </p>
        <p className="notes-small">
          Captions start off and can be switched on; they are delivered as a separate WebVTT
          track, not burned into the film frames.
        </p>
        <details
          className="film-transcript"
          onToggle={(event) => setTranscriptOpen((event.target as HTMLDetailsElement).open)}
        >
          <summary>Verbatim transcript</summary>
          {transcript === null ? (
            <p className="notes-small">Loading transcript…</p>
          ) : (
            <pre className="film-transcript-text">{transcript}</pre>
          )}
        </details>
      </div>
    </section>
  );
}
