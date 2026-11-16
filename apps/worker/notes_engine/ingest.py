"""YouTube -> transcript ingestion for Lecture Notes AI.

Start here: ``get_transcript()`` (section 6).

Public surface:
    IngestError, parse_video_id, get_transcript, get_playlist, parse_playlist_id, chunk_transcript
(plus a few small helpers such as format_timestamp that other modules may use).

Fallback chain for get_transcript():
    1. youtube-transcript-api (v1.x instance API): manual captions > auto captions,
       English first, then any language.
    2. yt-dlp subtitle extraction (json3 / vtt).
    3. Speech-to-text when there are no captions: yt-dlp audio download, ffmpeg
       splits it into 10-minute segments, and each segment is transcribed by the
       local faster-whisper model (CPU int8, preferred, no key) or by Groq Whisper
       (only when a Groq key is supplied). Every finished segment is checkpointed
       to disk under the work dir (keyed by video id), so a restart of a 24 h job
       resumes at the first unfinished segment.

Long videos (up to 24 h): caption downloads stream to disk with long read
timeouts and retries; timestamps are h:mm:ss with any number of hours.

How the file is organised
-------------------------
1. Re-exports - URL parsing, text cleaning, chunking and playlists now live in
   ``notes_engine/transcripts/``; every old name is still importable from here.
2. Small helpers (progress callback, HTTP session with a timeout).
3. Video metadata (title, channel, duration).
4. Stage 1: youtube-transcript-api.
5. Stage 2: yt-dlp subtitles.          Stage 3: local faster-whisper / Groq Whisper speech-to-text.
6. ``get_transcript`` - runs the stages in order and picks the friendliest error.

Note for maintainers: tests patch ``ingest._get_metadata``, ``ingest._oembed``,
``ingest._ytdlp_info`` and ``ingest._fetch_via_*`` - so those functions, and the code that calls
them, must stay in this module.

Secrets: the Groq key is only ever sent in the Authorization header of the Groq
request; it is never logged and never included in an error message.

Read next: ``transcripts/cleaning.py`` and ``transcripts/chunking.py``.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlparse

import requests

from . import cache as disk_cache
from .transcripts.chunking import (chunk_transcript, format_timestamp)
from .transcripts.cleaning import (build_segments, clean_text, dedupe_cues, merge_cues,
                                   parse_json3, parse_vtt)
from .transcripts.errors import MSG_CHANNEL, MSG_NO_CAPTIONS
from .transcripts.errors import (FAILURE_MESSAGES, FAILURE_PRIORITY, MSG_NO_CAPTIONS_WHISPER_FAILED, IngestError, StageFailure,
                                 ytdlp_error_kind)
from .transcripts.playlists import (PLAYLIST_SLACK, get_playlist, plain_text)
from .transcripts.youtube_urls import VIDEO_ID_RE, canonical_url, parse_playlist_id, parse_video_id

TRANSCRIPT_CACHE_DAYS = 30  # a video's captions rarely change; auto-captions may improve, so not forever

__all__ = [
    "IngestError",
    "parse_video_id",
    "get_transcript",
    "get_playlist",
    "parse_playlist_id",
    "chunk_transcript",
    "format_timestamp",
    "VIDEO_ID_RE",
    "MSG_CHANNEL",
    "MSG_NO_CAPTIONS",
]

# Short names the tests use for helpers that live in ``notes_engine/transcripts/``.
_Fail = StageFailure
_ytdlp_error_kind = ytdlp_error_kind
_dedupe_cues = dedupe_cues
_merge_cues = merge_cues
_build_segments = build_segments
_parse_json3 = parse_json3
_parse_vtt = parse_vtt
_PLAYLIST_SLACK = PLAYLIST_SLACK
_plain = plain_text

# --------------------------------------------------------------------------- #
# Constants for the fetch stages
# --------------------------------------------------------------------------- #

_HTTP_TIMEOUT = 20
# (connect, read) for big downloads: a 24 h json3 caption file can be 30-60 MB
_DOWNLOAD_TIMEOUT = (20, 180)
DOWNLOAD_RETRIES = 4
MAX_SUBTITLE_BYTES = 200 * 1024 * 1024
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3-turbo"
WHISPER_CHUNK_SECONDS = 600          # 10 min of 32 kbps mono mp3 ~ 2.4 MB
WHISPER_MAX_UPLOAD_BYTES = 24 * 1024 * 1024
# 24 h of ~50 kbps opus is ~540 MB; refuse anything absurdly larger
MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024
MAX_VIDEO_SECONDS = 25 * 3600

# local speech-to-text (faster-whisper, CPU int8); see LocalWhisperTranscriber
LOCAL_WHISPER_MODEL = "small"
_APP_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))   # apps/worker
_REPO_ROOT = os.path.abspath(os.path.join(_APP_ROOT, "..", ".."))
WHISPER_MODEL_DIR = os.path.join(_REPO_ROOT, ".tools", "whisper-models")  # gitignored, nuked
DEFAULT_WORK_DIR = os.path.join(_APP_ROOT, "backend", "output", "_cache")

# shared yt-dlp options: quiet, long-video-safe timeouts and retries, never follow a playlist, no disk cache
_YTDLP_COMMON = {
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "socket_timeout": 60,
    "retries": 10,
    "fragment_retries": 10,
    "extractor_retries": 3,
    "noplaylist": True,
    "cachedir": False,
}

# --------------------------------------------------------------------------- #
# 2. Small helpers
# --------------------------------------------------------------------------- #


def _progress(cb, stage: str, pct: int, msg: str) -> None:
    """Call the progress callback, ignoring any error it raises."""
    if cb is None:
        return
    try:
        cb(stage, int(pct), msg)
    except Exception:
        # A broken progress callback must never break ingestion.
        pass


class _TimeoutSession(requests.Session):
    """requests.Session with a default timeout (youtube-transcript-api sets none).

    The read timeout is long because a 24 h transcript is a big response."""

    def request(self, method, url, **kwargs):  # type: ignore[override]
        kwargs.setdefault("timeout", _DOWNLOAD_TIMEOUT)
        return super().request(method, url, **kwargs)


def _backoff(attempt: int) -> float:
    """Seconds to wait before retry number attempt+1 (1.5, 3, 6, 12 ... capped at 30)."""
    return min(30.0, 1.5 * (2 ** attempt))


def _download_to_file(url: str, dest: str, *, max_bytes: int = MAX_SUBTITLE_BYTES,
                      retries: int = DOWNLOAD_RETRIES, sleep=time.sleep) -> str:
    """Stream ``url`` to ``dest`` in 64 KB pieces (no whole-body buffering in memory).

    Retries timeouts, connection errors, 429 and 5xx with exponential backoff.
    Raises _Fail("blocked") when YouTube keeps answering 429, else _Fail("other")."""
    last = "unknown error"
    blocked = False
    for attempt in range(retries):
        if attempt:
            sleep(_backoff(attempt - 1))
        try:
            with requests.get(url, timeout=_DOWNLOAD_TIMEOUT, stream=True) as r:
                if r.status_code == 429 or r.status_code >= 500:
                    blocked = r.status_code == 429
                    last = f"HTTP {r.status_code}"
                    continue
                if r.status_code != 200:
                    raise _Fail("other", f"subtitle HTTP {r.status_code}")
                size = 0
                with open(dest, "wb") as fh:
                    for piece in r.iter_content(chunk_size=65536):
                        if not piece:
                            continue
                        size += len(piece)
                        if size > max_bytes:
                            raise _Fail("other", "subtitle file too large")
                        fh.write(piece)
                return dest
        except _Fail:
            raise
        except (requests.RequestException, OSError) as e:
            blocked = False
            last = f"{type(e).__name__}"
    if blocked:
        raise _Fail("blocked", "subtitle 429")
    raise _Fail("other", f"subtitle download: {last}")


# --------------------------------------------------------------------------- #
# 3. Video metadata
# --------------------------------------------------------------------------- #


def _ytdlp_info(video_id: str, cache: dict | None = None) -> dict:
    """yt-dlp metadata (incl. subtitle URLs). Raises _Fail.

    ``cache`` is a per-request dict so we ask yt-dlp at most once per video.
    """
    if cache is not None and "info" in cache:
        return cache["info"]
    try:
        import yt_dlp
    except ImportError:
        raise _Fail("other", "yt-dlp not installed") from None
    opts = dict(_YTDLP_COMMON, skip_download=True)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(canonical_url(video_id), download=False)
    except Exception as e:  # yt_dlp.utils.DownloadError & friends
        raise _Fail(_ytdlp_error_kind(str(e)), str(e)[:300]) from None
    if not isinstance(info, dict):
        raise _Fail("other", "yt-dlp returned no info")
    if cache is not None:
        cache["info"] = info
    return info


def _oembed(video_id: str) -> tuple[str, str]:
    """(title, channel) via YouTube oEmbed. Raises _Fail on any problem."""
    try:
        r = requests.get(
            "https://www.youtube.com/oembed",
            params={"url": canonical_url(video_id), "format": "json"},
            timeout=_HTTP_TIMEOUT,
        )
    except requests.RequestException as e:
        raise _Fail("other", f"oembed network: {type(e).__name__}") from None
    if r.status_code in (401, 403):
        raise _Fail("other", "oembed not allowed")  # often non-embeddable / age-gated
    if r.status_code == 404:
        raise _Fail("unavailable", "oembed 404")
    if r.status_code != 200:
        raise _Fail("other", f"oembed HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError:
        raise _Fail("other", "oembed bad json") from None
    title = clean_text(str(data.get("title") or "")) or ""
    channel = clean_text(str(data.get("author_name") or "")) or ""
    if not title:
        raise _Fail("other", "oembed empty")
    return title, channel


def _get_metadata(video_id: str, cache: dict) -> tuple[str, str, int | None]:
    """Return (title, channel, duration_sec|None). Never raises.

    oEmbed is fast but has no duration; yt-dlp is the fallback.
    """
    title = channel = ""
    duration = None
    try:
        title, channel = _oembed(video_id)
    except _Fail:
        pass
    if not title:
        try:
            info = _ytdlp_info(video_id, cache)
            title = clean_text(str(info.get("title") or ""))
            channel = clean_text(str(info.get("channel") or info.get("uploader") or ""))
            d = info.get("duration")
            duration = int(d) if isinstance(d, (int, float)) else None
        except _Fail:
            pass
    return title or f"YouTube video {video_id}", channel or "Unknown channel", duration


# --------------------------------------------------------------------------- #
# 4. Stage 1: youtube-transcript-api
# --------------------------------------------------------------------------- #


def _lang_rank(code: str) -> int:
    """0 for English, 1 for any other language (lower is preferred)."""
    c = (code or "").lower()
    if c == "en" or c.startswith("en-") or c.startswith("en_"):
        return 0
    return 1


def _pick_transcript(transcripts) -> object | None:
    """manual > auto, English before other languages -> but English auto beats
    non-English manual only if no English manual exists.

    Order: manual en, auto en, manual other, auto other.
    """
    items = list(transcripts)
    if not items:
        return None

    def key(t):
        return (_lang_rank(t.language_code), 1 if t.is_generated else 0)

    return sorted(items, key=key)[0]


def _classify_api_exception(e: Exception) -> _Fail:
    """Map a youtube-transcript-api exception to a ``_Fail`` with the right kind."""
    import youtube_transcript_api as yta

    name = type(e).__name__
    if isinstance(e, yta.AgeRestricted):
        return _Fail("age", name)
    if isinstance(e, (yta.IpBlocked, yta.RequestBlocked)):
        return _Fail("blocked", name)
    if isinstance(e, (yta.VideoUnavailable, yta.InvalidVideoId)):
        return _Fail("unavailable", name)
    if isinstance(e, (yta.TranscriptsDisabled, yta.NoTranscriptFound)):
        return _Fail("nocaps", name)
    if isinstance(e, yta.VideoUnplayable):
        reason = str(getattr(e, "reason", "") or "") + " " + str(e)
        kind = _ytdlp_error_kind(reason)
        return _Fail(kind if kind != "other" else "unavailable", name)
    if isinstance(e, yta.PoTokenRequired):
        return _Fail("blocked", name)
    if isinstance(e, (requests.Timeout, requests.ConnectionError)):
        return _Fail("other", "network error")
    return _Fail("other", f"{name}: {str(e)[:200]}")


def _fetch_via_api(video_id: str) -> tuple[list[dict], str, str, float]:
    """Return (segments, language_code, source, est_duration)."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        raise _Fail("other", "youtube-transcript-api not installed") from None

    api = YouTubeTranscriptApi(http_client=_TimeoutSession())
    last_exc: Exception | None = None
    attempts = 3
    for attempt in range(attempts):
        try:
            tlist = api.list(video_id)
            chosen = _pick_transcript(tlist)
            if chosen is None:
                raise _Fail("nocaps", "no transcripts listed")
            fetched = chosen.fetch()
            break
        except _Fail:
            raise
        except Exception as e:
            last_exc = e
            fail = _classify_api_exception(e)
            if fail.kind == "other" and attempt < attempts - 1:
                time.sleep(_backoff(attempt))  # retry transient failures
                continue
            raise fail from None
    else:  # pragma: no cover - loop always breaks or raises
        raise _classify_api_exception(last_exc or Exception("unknown"))

    cues = []
    est_end = 0.0
    for snippet in fetched:
        start = float(snippet.start)
        dur = float(getattr(snippet, "duration", 0.0) or 0.0)
        cues.append((start, dur, str(snippet.text).split("\n")))
        est_end = max(est_end, start + dur)
    segments = _build_segments(cues)
    if not segments:
        raise _Fail("nocaps", "transcript empty after cleaning")
    source = "auto-captions" if fetched.is_generated else "captions"
    return segments, fetched.language_code, source, est_end


# --------------------------------------------------------------------------- #
# 5a. Stage 2: yt-dlp subtitles
# --------------------------------------------------------------------------- #


def _pick_ytdlp_track(info: dict) -> tuple[list[dict], str, str] | None:
    """Return (formats, lang, source) for the best subtitle track, or None."""
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    video_lang = (info.get("language") or "").lower()

    # candidates sorted by (language rank, manual=0 / auto=1)
    cands: list[tuple[tuple, str, str, list[dict]]] = []
    for lang, fmts in subs.items():
        if fmts and lang != "live_chat":
            cands.append(((_lang_rank(lang), 0), lang, "captions", fmts))
    for lang, fmts in autos.items():
        if not fmts or lang == "live_chat":
            continue
        base = lang.split("-")[0].lower()
        # Auto tracks list ~100 machine-translated languages; keep the original
        # ("xx-orig" or the video's own language) and English.
        orig = lang.endswith("-orig") or (video_lang and base == video_lang and "-" not in lang)
        if orig or lang.lower() == "en":
            cands.append(((_lang_rank(lang), 1), lang, "auto-captions", fmts))
    if not cands:
        return None
    cands.sort(key=lambda c: c[0])
    _, lang, source, fmts = cands[0]
    return fmts, lang, source


def _fetch_via_ytdlp(video_id: str, cache: dict) -> tuple[list[dict], str, str, float]:
    """Return (segments, language_code, source, est_duration) from yt-dlp's subtitle tracks."""
    info = _ytdlp_info(video_id, cache)
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise _Fail("live", "live")
    pick = _pick_ytdlp_track(info)
    if pick is None:
        raise _Fail("nocaps", "yt-dlp found no subtitle tracks")
    fmts, lang, source = pick

    # choose a format we can parse (json3 preferred, then vtt)
    by_ext = {f.get("ext"): f for f in fmts if f.get("url")}
    order = ["json3", "vtt", "srv3"]
    chosen = next((by_ext[e] for e in order if e in by_ext and e != "srv3"), None)
    if chosen is None:
        raise _Fail("nocaps", "no json3/vtt subtitle format")

    # only download from YouTube / Google video hosts
    url = chosen["url"]
    host = (urlparse(url).hostname or "").lower()
    if not (host.endswith(".youtube.com") or host == "youtube.com" or host.endswith(".googlevideo.com")):
        raise _Fail("other", "unexpected subtitle host")
    tmp = tempfile.mkdtemp(prefix="lna_subs_")
    try:
        path = _download_to_file(url, os.path.join(tmp, "subs." + str(chosen.get("ext"))))
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                if chosen.get("ext") == "json3":
                    cues = _parse_json3(json.load(fh))
                else:
                    cues = _parse_vtt(fh.read())
        except ValueError:
            raise _Fail("other", "subtitle parse error") from None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    segments = _build_segments(cues)
    if not segments:
        raise _Fail("nocaps", "subtitles empty after cleaning")
    d = info.get("duration")
    est = float(d) if isinstance(d, (int, float)) else (cues[-1][0] + cues[-1][1] if cues else 0.0)
    cache["duration"] = int(d) if isinstance(d, (int, float)) else None
    return segments, lang, source, est


# --------------------------------------------------------------------------- #
# 5b. Stage 3: speech-to-text (local faster-whisper or Groq), chunked + checkpointed
# --------------------------------------------------------------------------- #
#
# Layout of the checkpoint dir  <work_dir>/<video_id>/stt/ :
#   audio.<ext>             yt-dlp download (resumable .part; deleted after the split)
#   chunks/chunk_NNNN.mp3   10-min 16 kHz mono segments made by ffmpeg
#   chunks/segments.csv     ffmpeg's segment list (exact start/end of every chunk)
#   split.done              marker: the split finished, chunks are complete
#   done/chunk_NNNN.json    checkpoint per finished chunk (absolute timestamps)
#   transcript.json         final result; a re-run returns it without any work
# Every file is written atomically (tmp + os.replace), so a kill at any moment
# leaves either a complete checkpoint or none.


def _find_ffmpeg() -> str | None:
    """FFMPEG_PATH, then ffmpeg on PATH, then the repo-local imageio-ffmpeg binary."""
    env = (os.environ.get("FFMPEG_PATH") or "").strip()
    if env and os.path.isfile(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:  # pip install -e .[whisper] ships a static ffmpeg inside the venv
        import imageio_ffmpeg  # type: ignore

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        return exe if exe and os.path.isfile(exe) else None
    except Exception:
        return None


def _atomic_write_json(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)


def _read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


_PARTIAL_SUFFIXES = (".part", ".ytdl", ".tmp")


def _download_audio(video_id: str, out_dir: str, cache: dict) -> str:
    import yt_dlp

    done = [f for f in glob.glob(os.path.join(out_dir, "audio.*")) if not f.endswith(_PARTIAL_SUFFIXES)]
    if done:  # finished in an earlier run
        return done[0]
    opts = dict(
        _YTDLP_COMMON,
        # low-bitrate audio: speech only, keeps 24 h near 0.5 GB
        format="bestaudio[abr<=64]/worstaudio[acodec!=none]/bestaudio/best",
        outtmpl=os.path.join(out_dir, "audio.%(ext)s"),
        max_filesize=MAX_AUDIO_BYTES,
        continuedl=True,          # resume a .part file after a restart
        http_chunk_size=10 * 1024 * 1024,
        skip_download=False,
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(canonical_url(video_id), download=True)
        if isinstance(info, dict) and "info" not in cache:
            cache["info"] = info
    except Exception as e:
        raise _Fail(_ytdlp_error_kind(str(e)), str(e)[:300]) from None
    files = [f for f in glob.glob(os.path.join(out_dir, "audio.*")) if not f.endswith(_PARTIAL_SUFFIXES)]
    if not files:
        raise _Fail("other", "audio download produced no file (maybe too large)")
    return files[0]


def _read_segment_list(chunk_dir: str) -> list[tuple[str, float]]:
    """[(chunk_path, start_sec)] from ffmpeg's segments.csv (falls back to i * chunk length)."""
    chunks = sorted(glob.glob(os.path.join(chunk_dir, "chunk_*.mp3")))
    starts: dict[str, float] = {}
    try:
        with open(os.path.join(chunk_dir, "segments.csv"), "r", encoding="utf-8") as fh:
            for line in fh:
                parts = line.strip().split(",")
                if len(parts) >= 2:
                    try:
                        starts[os.path.basename(parts[0])] = float(parts[1])
                    except ValueError:
                        pass
    except OSError:
        pass
    return [(c, starts.get(os.path.basename(c), i * float(WHISPER_CHUNK_SECONDS)))
            for i, c in enumerate(chunks)]


def _split_audio(ffmpeg: str, src: str, out_dir: str) -> list[tuple[str, float]]:
    """Split src into WHISPER_CHUNK_SECONDS mp3 chunks; returns [(path, start_sec)]."""
    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, "chunk_*.mp3")):  # half-finished earlier split
        os.remove(old)
    pattern = os.path.join(out_dir, "chunk_%04d.mp3")
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k",
        "-f", "segment", "-segment_time", str(WHISPER_CHUNK_SECONDS),
        "-segment_list", os.path.join(out_dir, "segments.csv"), "-segment_list_type", "csv",
        "-reset_timestamps", "1", pattern,
    ]
    try:
        # 24 h of audio re-encodes in a few minutes; allow plenty
        proc = subprocess.run(cmd, capture_output=True, timeout=3 * 3600)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise _Fail("other", f"ffmpeg failed: {type(e).__name__}") from None
    if proc.returncode != 0:
        raise _Fail("other", "ffmpeg failed: " + proc.stderr.decode("utf-8", "replace")[-200:])
    chunks = _read_segment_list(out_dir)
    if not chunks:
        raise _Fail("other", "ffmpeg produced no audio chunks")
    for c, _ in chunks:
        if os.path.getsize(c) > WHISPER_MAX_UPLOAD_BYTES:
            raise _Fail("other", "audio chunk too large for Groq upload")
    return chunks


_WHISPER_LANGS = {
    "english": "en", "hindi": "hi", "spanish": "es", "french": "fr", "german": "de",
    "portuguese": "pt", "italian": "it", "russian": "ru", "japanese": "ja", "korean": "ko",
    "chinese": "zh", "arabic": "ar", "turkish": "tr", "dutch": "nl", "polish": "pl",
    "indonesian": "id", "tamil": "ta", "telugu": "te", "marathi": "mr", "bengali": "bn",
    "urdu": "ur", "gujarati": "gu", "ukrainian": "uk", "vietnamese": "vi", "thai": "th",
}


def _groq_transcribe_chunk(path: str, groq_key: str) -> tuple[list[dict], str]:
    """Return (segments, language_code) for one audio chunk."""
    headers = {"Authorization": f"Bearer {groq_key}"}
    last = "unknown error"
    for attempt in range(4):
        try:
            with open(path, "rb") as fh:
                r = requests.post(
                    GROQ_URL,
                    headers=headers,
                    files={"file": (os.path.basename(path), fh, "audio/mpeg")},
                    data={"model": GROQ_MODEL, "response_format": "verbose_json", "temperature": "0"},
                    timeout=300,
                )
        except requests.RequestException as e:
            last = f"network error ({type(e).__name__})"
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code == 200:
            try:
                data = r.json()
                lang = str(data.get("language") or "").lower()
                return data.get("segments") or [], _WHISPER_LANGS.get(lang, lang)
            except ValueError:
                last = "invalid response from Groq"
                continue
        if r.status_code in (401, 403):
            raise _Fail("other", "the Groq API key was rejected (check that it is correct)")
        if r.status_code == 429 or r.status_code >= 500:
            last = "Groq rate limit reached" if r.status_code == 429 else f"Groq server error {r.status_code}"
            try:
                wait = float(r.headers.get("retry-after", 0)) or 5 * (attempt + 1)
            except ValueError:
                wait = 5 * (attempt + 1)
            time.sleep(min(wait, 30))
            continue
        last = f"Groq returned HTTP {r.status_code}"
        break
    raise _Fail("other", last)


class GroqTranscriber:
    """Groq Whisper (cloud). Needs a key; used only when the local model is missing."""

    name = "groq"

    def __init__(self, key: str):
        self._key = key

    def transcribe(self, path: str) -> tuple[list[dict], str]:
        return _groq_transcribe_chunk(path, self._key)


class LocalWhisperTranscriber:
    """faster-whisper on the CPU with int8 weights (Apple Silicon friendly, no GPU).

    Runs on the CPU on purpose: the Metal GPU belongs to llama-server (one GPU job
    at a time on the 16 GB M2). The model downloads on first use into
    <repo>/.tools/whisper-models (gitignored, removed by scripts/nuke.sh)."""

    name = "local"

    def __init__(self, model: str | None = None, model_dir: str | None = None):
        self.model_name = (model or os.environ.get("LNAI_WHISPER_MODEL") or LOCAL_WHISPER_MODEL).strip()
        self.model_dir = model_dir or os.environ.get("LNAI_WHISPER_DIR") or WHISPER_MODEL_DIR
        self._model = None

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel  # type: ignore

            os.makedirs(self.model_dir, exist_ok=True)
            threads = max(1, (os.cpu_count() or 4) - 1)
            self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8",
                                       cpu_threads=threads, download_root=self.model_dir)
        return self._model

    def transcribe(self, path: str) -> tuple[list[dict], str]:
        try:
            model = self._load()
            segs, info = model.transcribe(path, beam_size=1, vad_filter=True,
                                          condition_on_previous_text=False)
            out = [{"start": float(s.start), "end": float(s.end), "text": str(s.text),
                    "no_speech_prob": float(getattr(s, "no_speech_prob", 0.0) or 0.0)} for s in segs]
        except _Fail:
            raise
        except Exception as e:  # model download / decode problems
            raise _Fail("other", f"local Whisper failed ({type(e).__name__})") from None
        return out, str(getattr(info, "language", "") or "")


def _local_whisper_available() -> bool:
    try:
        import importlib.util

        return importlib.util.find_spec("faster_whisper") is not None
    except Exception:
        return False


def _pick_transcriber(groq_key: str | None):
    """LNAI_WHISPER = auto (default) | local | groq | off.

    auto: local faster-whisper when installed, else Groq when a key is given, else None."""
    mode = (os.environ.get("LNAI_WHISPER") or "auto").strip().lower()
    if mode == "off":
        return None
    if mode in ("auto", "local") and _local_whisper_available():
        return LocalWhisperTranscriber()
    if mode in ("auto", "groq") and groq_key:
        return GroqTranscriber(groq_key)
    return None


def _fetch_via_whisper(video_id: str, transcriber, cache: dict, progress,
                       work_dir: str | None = None) -> tuple[list[dict], str, str, float]:
    base = os.path.join(work_dir or DEFAULT_WORK_DIR, video_id, "stt")
    final = os.path.join(base, "transcript.json")
    cached = _read_json(final)
    if isinstance(cached, dict) and cached.get("segments"):
        _progress(progress, "transcript", 95, "Using the speech-to-text result saved earlier...")
        return cached["segments"], cached.get("language") or "en", "whisper", float(cached.get("est") or 0.0)

    chunk_dir = os.path.join(base, "chunks")
    done_dir = os.path.join(base, "done")
    marker = os.path.join(base, "split.done")
    os.makedirs(done_dir, exist_ok=True)

    if os.path.isfile(marker):
        chunks = _read_segment_list(chunk_dir)
    else:
        info = cache.get("info") or {}
        d = info.get("duration") if isinstance(info, dict) else None
        if isinstance(d, (int, float)) and d > MAX_VIDEO_SECONDS:
            raise _Fail("other", "the video is longer than 24 hours")
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            raise _Fail("other", "ffmpeg was not found (run 'pip install -e .[whisper]' in apps/worker)")
        _progress(progress, "transcript", 40, "No captions found - downloading audio for speech-to-text...")
        audio = _download_audio(video_id, base, cache)
        _progress(progress, "transcript", 50, "Preparing audio...")
        chunks = _split_audio(ffmpeg, audio, chunk_dir)
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write(str(len(chunks)))
        try:  # the chunks hold everything now; free the disk space
            os.remove(audio)
        except OSError:
            pass
    if not chunks:
        raise _Fail("other", "no audio chunks to transcribe")

    cues: list[tuple[float, float, list[str]]] = []
    language = ""
    n = len(chunks)
    for i, (path, offset) in enumerate(chunks):
        ck = os.path.join(done_dir, os.path.splitext(os.path.basename(path))[0] + ".json")
        rec = _read_json(ck)
        if not (isinstance(rec, dict) and isinstance(rec.get("segments"), list)):
            _progress(progress, "transcript", 55 + int(40 * i / n),
                      f"Transcribing audio {i + 1}/{n} ({format_timestamp(offset)})...")
            segs, lang = transcriber.transcribe(path)
            kept = []
            for seg in segs:
                if float(seg.get("no_speech_prob", 0) or 0) > 0.9:
                    continue
                s = float(seg.get("start", 0)) + offset
                e = float(seg.get("end", 0)) + offset
                text = str(seg.get("text", "")).strip()
                if text:
                    kept.append({"start": round(s, 2), "end": round(max(s, e), 2), "text": text})
            rec = {"offset": offset, "language": lang, "segments": kept}
            _atomic_write_json(ck, rec)
        language = language or str(rec.get("language") or "")
        for seg in rec["segments"]:
            s, e = float(seg["start"]), float(seg["end"])
            cues.append((s, max(0.0, e - s), [str(seg["text"])]))

    segments = _build_segments(cues)
    if not segments:
        raise _Fail("other", "no speech was detected in the audio")
    est = max((c[0] + c[1] for c in cues), default=0.0)
    language = _WHISPER_LANGS.get(language.lower(), language.lower()) or "en"
    _atomic_write_json(final, {"segments": segments, "language": language, "est": est,
                               "engine": getattr(transcriber, "name", "")})
    shutil.rmtree(chunk_dir, ignore_errors=True)  # transcript.json is the resume point now
    return segments, language, "whisper", est


# --------------------------------------------------------------------------- #
# 6. Public: get_transcript
# --------------------------------------------------------------------------- #


def get_transcript(url: str, *, groq_key: str | None = None, progress=None,
                   work_dir: str | None = None) -> dict:
    """Fetch and clean the transcript for a YouTube video. Raises IngestError.

    ``work_dir`` holds the speech-to-text checkpoints (``<work_dir>/<video_id>/stt``);
    default $LNAI_WORK_DIR or apps/worker/backend/output/_cache.

    Returns {video_id, url, title, channel, duration_sec, language, source, segments}.
    """
    # Step 1: validate the link and check the disk cache
    video_id = parse_video_id(url)
    _progress(progress, "transcript", 3, "Checking the video link...")
    saved = disk_cache.get("transcript", video_id, max_age_sec=TRANSCRIPT_CACHE_DAYS * 86400)
    if isinstance(saved, dict) and saved.get("segments") and saved.get("video_id") == video_id:
        _progress(progress, "transcript", 100, f"Transcript ready ({len(saved['segments'])} segments, saved earlier).")
        return saved
    cache: dict = {}  # per-request scratch space shared by the stages (yt-dlp info, duration)
    groq_key = (groq_key or "").strip() or None

    # Step 2: title / channel / duration
    _progress(progress, "transcript", 8, "Looking up the video title...")
    title, channel, duration = _get_metadata(video_id, cache)

    # Step 3: caption stages, in order, until one works
    failures: list[_Fail] = []
    result = None
    stages = [
        ("api", 15, "Fetching captions from YouTube...", lambda: _fetch_via_api(video_id)),
        ("ytdlp", 30, "Trying another way to fetch captions...", lambda: _fetch_via_ytdlp(video_id, cache)),
    ]
    for _name, pct, msg, fetch in stages:
        _progress(progress, "transcript", pct, msg)
        try:
            result = fetch()
            break
        except _Fail as f:
            failures.append(f)
            # Private/unavailable videos won't get better with another method.
            if f.kind in ("unavailable", "invalid", "live"):
                break
        except Exception as e:  # defensive: never leak raw library errors
            failures.append(_Fail("other", f"{type(e).__name__}: {str(e)[:200]}"))

    # Step 4: speech-to-text (local Whisper, or Groq with a key), only if the video itself is reachable
    whisper_fail: _Fail | None = None
    hard = any(f.kind in ("unavailable", "invalid", "live") for f in failures)
    transcriber = _pick_transcriber(groq_key) if result is None and not hard else None
    work_dir = work_dir or os.environ.get("LNAI_WORK_DIR") or DEFAULT_WORK_DIR
    if transcriber is not None:
        try:
            result = _fetch_via_whisper(video_id, transcriber, cache, progress, work_dir)
        except _Fail as f:
            whisper_fail = f
        except Exception as e:
            whisper_fail = _Fail("other", f"{type(e).__name__}")

    if result is None:
        raise IngestError(_final_message(failures, whisper_fail, transcriber is not None))

    # Step 5: assemble, cache and return
    segments, language, source, est_end = result
    if duration is None:
        duration = cache.get("duration")
    if duration is None and est_end:
        duration = int(round(est_end))
    _progress(progress, "transcript", 100, f"Transcript ready ({len(segments)} segments).")
    out = {
        "video_id": video_id,
        "url": canonical_url(video_id),
        "title": title,
        "channel": channel,
        "duration_sec": duration,
        "language": language or "en",
        "source": source,
        "segments": segments,
    }
    disk_cache.put("transcript", video_id, out)
    return out


def _final_message(failures: list[_Fail], whisper_fail: _Fail | None, had_key: bool) -> str:
    """Pick the single most helpful message when every stage failed."""
    kinds = [f.kind for f in failures]
    best = max(kinds, key=lambda k: FAILURE_PRIORITY.get(k, 0)) if kinds else "other"
    if whisper_fail is not None and best in ("nocaps", "other", "blocked"):
        why = whisper_fail.detail or "unknown error"
        # whisper details are produced by this module (no secrets); trim for safety
        return MSG_NO_CAPTIONS_WHISPER_FAILED.format(why=why[:200])
    if best == "nocaps" and had_key:
        return MSG_NO_CAPTIONS_WHISPER_FAILED.format(why="could not transcribe the audio.")
    return FAILURE_MESSAGES.get(best, FAILURE_MESSAGES["other"])
