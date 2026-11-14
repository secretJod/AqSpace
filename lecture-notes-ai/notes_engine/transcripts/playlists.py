"""YouTube playlist -> list of videos (metadata only, nothing is downloaded).

Public: ``get_playlist(url, limit)``.  It uses yt-dlp's "flat" listing, so only one request
is made for the whole playlist.  Private / deleted entries are skipped and counted.

Read next: ``../ingest.py``.
"""
from __future__ import annotations

import re

from .cleaning import WS_RE
from .errors import (MSG_PLAYLIST_BLOCKED, MSG_PLAYLIST_NOT_FOUND, MSG_PLAYLIST_OTHER, MSG_PLAYLIST_PRIVATE,
                     PlaylistError)
from .youtube_urls import VIDEO_ID_RE, parse_playlist_id

PLAYLIST_LIMIT = 200
PLAYLIST_SLACK = 25  # extra raw entries fetched so skipped (private/deleted) ones don't eat the cap

# control characters and invisible bidi marks that must not reach the UI
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f​‪-‮⁦-⁩]")
_DEAD_TITLES = {"[private video]", "[deleted video]", "private video", "deleted video"}

# --------------------------------------------------------------------------- #
# 1. Small helpers
# --------------------------------------------------------------------------- #


def plain_text(text, limit: int) -> str:
    """Single-line, control-character-free text capped at `limit` characters."""
    s = _CTRL_RE.sub(" ", str(text or ""))
    return WS_RE.sub(" ", s).strip()[:limit]


def playlist_error(msg: str) -> PlaylistError:
    """Map a yt-dlp failure to a friendly PlaylistError (never echoes raw library text)."""
    m = (msg or "").lower()
    # note: "and" binds tighter than "or" here: ("sign in" in m and "not a bot" not in m)
    if "private" in m or "sign in" in m and "not a bot" not in m or "log in" in m or "members-only" in m:
        return PlaylistError(MSG_PLAYLIST_PRIVATE, 403)
    if ("does not exist" in m or "not found" in m or "404" in m or "unavailable" in m
            or "been removed" in m or "terminated" in m or "no longer available" in m
            or "not a valid" in m or "invalid" in m):
        return PlaylistError(MSG_PLAYLIST_NOT_FOUND, 404)
    if "not a bot" in m or "429" in m or "too many requests" in m or ("rate" in m and "limit" in m):
        return PlaylistError(MSG_PLAYLIST_BLOCKED, 503)
    return PlaylistError(MSG_PLAYLIST_OTHER, 502)


def playlist_entry(e) -> dict | None:
    """Normalise one flat yt-dlp entry; None for private/deleted/invalid ones."""
    if not isinstance(e, dict):
        return None
    vid = e.get("id")
    if not isinstance(vid, str) or not VIDEO_ID_RE.match(vid):
        return None
    title = plain_text(e.get("title"), 200)
    if not title or title.lower() in _DEAD_TITLES:
        return None
    if str(e.get("availability") or "").lower() in ("private", "needs_auth", "premium_only", "subscriber_only"):
        return None
    d = e.get("duration")
    # a believable duration only: a number (not a bool) between 0 and 10 days
    dur = int(d) if isinstance(d, (int, float)) and not isinstance(d, bool) and 0 < d < 10 * 24 * 3600 else None
    return {
        "id": vid,
        "title": title,
        "channel": plain_text(e.get("channel") or e.get("uploader"), 120),
        "duration_sec": dur,
    }


# --------------------------------------------------------------------------- #
# 2. Talking to yt-dlp
# --------------------------------------------------------------------------- #


def ytdlp_playlist(list_id: str, raw_limit: int) -> dict:
    """Flat yt-dlp listing of a playlist (no per-video requests, no download)."""
    try:
        import yt_dlp
    except ImportError:
        raise PlaylistError(MSG_PLAYLIST_OTHER, 503) from None
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 1,
        "cachedir": False,
        "playlistend": raw_limit,
        "ignoreerrors": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/playlist?list={list_id}", download=False)
    except Exception as e:  # yt_dlp.utils.DownloadError & friends
        raise playlist_error(str(e)) from None
    if not isinstance(info, dict):
        raise PlaylistError(MSG_PLAYLIST_NOT_FOUND, 404)
    return info


# --------------------------------------------------------------------------- #
# 3. get_playlist
# --------------------------------------------------------------------------- #


def get_playlist(url: str, limit: int = PLAYLIST_LIMIT) -> dict:
    """List the videos of a public/unlisted YouTube playlist (metadata only).

    Returns {id, title, channel, count, videos:[{id, title, channel, duration_sec}],
    truncated, skipped}. Private/deleted entries are skipped (counted in `skipped`);
    at most `limit` videos are returned (`truncated` is True when more exist).
    Raises IngestError (PlaylistError) with a user-safe message.
    """
    list_id = parse_playlist_id(url)
    try:
        limit = max(1, min(int(limit), 1000))
    except (TypeError, ValueError):
        limit = PLAYLIST_LIMIT
    raw_limit = limit + PLAYLIST_SLACK
    info = ytdlp_playlist(list_id, raw_limit)

    entries = info.get("entries")
    if entries is None:
        raise PlaylistError(MSG_PLAYLIST_NOT_FOUND, 404)

    # keep usable, unique videos in playlist order
    videos: list[dict] = []
    seen: set[str] = set()
    skipped = 0
    raw_count = 0
    for e in entries:
        raw_count += 1
        v = playlist_entry(e)
        if v is None:
            skipped += 1
            continue
        if v["id"] in seen:
            continue
        seen.add(v["id"])
        videos.append(v)
    truncated = len(videos) > limit or (raw_count >= raw_limit and len(videos) >= limit)
    videos = videos[:limit]

    title = plain_text(info.get("title"), 150) or "YouTube playlist"
    channel = plain_text(info.get("channel") or info.get("uploader"), 120)
    if not channel and videos:  # fall back to the first video's channel
        channel = videos[0]["channel"]
    # YouTube's playlist page omits the per-video channel for the playlist owner's own videos
    for v in videos:
        if not v["channel"]:
            v["channel"] = channel
    return {
        "id": list_id,
        "title": title,
        "channel": channel,
        "count": len(videos),
        "videos": videos,
        "truncated": bool(truncated),
        "skipped": skipped,
    }
