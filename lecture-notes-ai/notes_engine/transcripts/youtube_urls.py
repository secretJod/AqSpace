"""Checking YouTube links (this is also our SSRF guard).

Only real YouTube hosts are accepted, so the backend can never be tricked into fetching an
arbitrary server.  Two public functions:

* ``parse_video_id(url)``    -> the 11-character video id
* ``parse_playlist_id(url)`` -> the playlist id

Read next: ``cleaning.py``.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

from .errors import (MSG_CHANNEL, MSG_INVALID, MSG_NOT_VIDEO, MSG_PLAYLIST, MSG_NOT_PLAYLIST, MSG_PLAYLIST_MIX, MSG_PLAYLIST_PRIVATE, IngestError,
                     PlaylistError)

# --------------------------------------------------------------------------- #
# 1. What a valid id / host looks like
# --------------------------------------------------------------------------- #

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
PATH_PREFIXES = ("shorts", "embed", "live", "v", "e", "watch")  # youtube.com/<prefix>/<id>
CHANNEL_PREFIXES = ("channel", "c", "user")  # youtube.com/<prefix>/<name> is a channel, not a video

_NOT_YOUTUBE = ("Only YouTube links are supported (youtube.com or youtu.be). "
                "That link points somewhere else.")


def canonical_url(video_id: str) -> str:
    """The normal watch URL for a video id."""
    return f"https://www.youtube.com/watch?v={video_id}"


def _split_url(raw: str, error: type[IngestError], message: str):
    """Parse ``raw`` (scheme added if missing) and run the safety checks shared by both parsers.

    Returns ``(parsed, host)`` or raises ``error(message)``.
    """
    if "://" not in raw:
        raw = "https://" + raw.lstrip("/")
    try:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port  # may raise ValueError
    except ValueError:
        raise error(message) from None
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise error(message)
    if port not in (None, 80, 443):
        raise error(message)
    return parsed, host


def _looks_unsafe(raw: str) -> bool:
    """Empty, absurdly long, or containing control characters."""
    return not raw or len(raw) > 2048 or any(c in raw for c in "\r\n\t\x00")


# --------------------------------------------------------------------------- #
# 2. Video links
# --------------------------------------------------------------------------- #


def parse_video_id(url: str) -> str:
    """Return the 11-char video id for a YouTube URL, or raise IngestError.

    Only real YouTube hosts are accepted; anything else is rejected so the
    backend can never be pointed at an arbitrary server. A bare 11-character
    video id is also accepted.
    """
    if not isinstance(url, str):
        raise IngestError(MSG_INVALID)
    raw = url.strip()
    if _looks_unsafe(raw):
        raise IngestError(MSG_INVALID)
    if VIDEO_ID_RE.match(raw):
        return raw
    parsed, host = _split_url(raw, IngestError, MSG_INVALID)

    candidate = None
    segments = [s for s in parsed.path.split("/") if s]
    if host in SHORT_HOSTS:                      # youtu.be/<id>
        if segments:
            candidate = segments[0]
    elif host in YOUTUBE_HOSTS:
        first = segments[0] if segments else ""
        query = parse_qs(parsed.query)
        if first == "watch" and len(segments) == 1:  # youtube.com/watch?v=<id>
            candidate = (query.get("v") or [None])[0]
            if candidate is None and query.get("list"):
                raise IngestError(MSG_PLAYLIST)
        elif len(segments) >= 2 and first in PATH_PREFIXES:  # youtube.com/shorts/<id> ...
            candidate = segments[1]
        elif first == "playlist":
            raise IngestError(MSG_PLAYLIST)
        elif first.startswith("@") or first in CHANNEL_PREFIXES:  # a channel, not a video
            raise IngestError(MSG_CHANNEL)
        elif segments:
            raise IngestError(MSG_NOT_VIDEO)
    else:
        raise IngestError(_NOT_YOUTUBE)
    if not candidate or not VIDEO_ID_RE.match(candidate):
        raise IngestError(MSG_INVALID)
    return candidate


# --------------------------------------------------------------------------- #
# 3. Playlist links
# --------------------------------------------------------------------------- #


def parse_playlist_id(url: str) -> str:
    """Return the playlist id of a YouTube playlist link, or raise IngestError.

    Accepted: youtube.com/playlist?list=ID, youtube.com/watch?v=VID&list=ID,
    youtu.be/VID?list=ID (and embed/videoseries?list=ID). Only real YouTube hosts
    are accepted (same SSRF guard as parse_video_id) and the id must match
    PLAYLIST_ID_RE exactly.
    """
    if not isinstance(url, str):
        raise PlaylistError(MSG_NOT_PLAYLIST)
    raw = url.strip()
    if _looks_unsafe(raw):
        raise PlaylistError(MSG_NOT_PLAYLIST)
    parsed, host = _split_url(raw, PlaylistError, MSG_NOT_PLAYLIST)

    segments = [s for s in parsed.path.split("/") if s]
    if host in SHORT_HOSTS:
        if len(segments) != 1 or not VIDEO_ID_RE.match(segments[0]):
            raise PlaylistError(MSG_NOT_PLAYLIST)
    elif host in YOUTUBE_HOSTS:
        ok = (segments == ["playlist"] or segments == ["watch"]
              or segments == ["embed", "videoseries"])
        if not ok:
            raise PlaylistError(MSG_NOT_PLAYLIST)
    else:
        raise PlaylistError(_NOT_YOUTUBE)

    ids = parse_qs(parsed.query).get("list") or []
    if len(ids) != 1:
        raise PlaylistError(MSG_NOT_PLAYLIST)
    list_id = ids[0]
    if list_id in ("WL", "LL"):  # Watch later / Liked videos: always private
        raise PlaylistError(MSG_PLAYLIST_PRIVATE)
    if not PLAYLIST_ID_RE.fullmatch(list_id):  # fullmatch: "$" alone would accept a trailing newline
        raise PlaylistError(MSG_NOT_PLAYLIST)
    if list_id.startswith("RD"):  # auto-generated Mix / radio
        raise PlaylistError(MSG_PLAYLIST_MIX)
    return list_id
