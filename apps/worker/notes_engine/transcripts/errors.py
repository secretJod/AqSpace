"""Errors and user-facing messages for transcript and playlist ingestion.

1. Public exceptions   - ``IngestError`` (any failure) and ``PlaylistError`` (with an HTTP status).
2. Video messages      - one friendly text per failure kind, plus how to pick the "best" one.
3. Internal signal     - ``StageFailure`` (old name ``_Fail``): one fetch stage failed, and why.
4. yt-dlp error text   - ``ytdlp_error_kind()`` maps raw yt-dlp messages to a failure kind.
5. Playlist messages.

Every message here is safe to show to a user: no keys, no raw library errors.

Read next: ``youtube_urls.py``.
"""

from __future__ import annotations

# --------------------------------------------------------------------------- #
# 1. Public exceptions
# --------------------------------------------------------------------------- #


class IngestError(Exception):
    """Raised for any ingestion failure. The message is safe to show to users."""


class PlaylistError(IngestError):
    """IngestError with an HTTP status hint for the API layer (message is user-safe)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------- #
# 2. Messages for a single video
# --------------------------------------------------------------------------- #

MSG_INVALID = (
    "That doesn't look like a valid YouTube link. Paste a video URL such as "
    "https://www.youtube.com/watch?v=XXXXXXXXXXX or https://youtu.be/XXXXXXXXXXX."
)
MSG_CHANNEL = (
    "That is a YouTube channel link, not a video. Open one of the channel's videos and paste that video's link instead."
)
MSG_PLAYLIST = (
    "That is a YouTube playlist link without a specific video. Open a video "
    "from the playlist and paste its link, or use the playlist import instead."
)
MSG_NOT_VIDEO = (
    "That YouTube link doesn't point to a single video. Paste a video URL such as "
    "https://www.youtube.com/watch?v=XXXXXXXXXXX or https://youtu.be/XXXXXXXXXXX."
)
MSG_UNAVAILABLE = (
    "This video is unavailable. It may be private, deleted, members-only or "
    "blocked in your region. Check that the link opens in a normal browser "
    "window while signed out."
)
MSG_AGE = (
    "This video is age-restricted, so YouTube won't release its captions "
    "without a signed-in account. Please pick a video that isn't age-restricted."
)
MSG_BLOCKED = (
    "YouTube is rate-limiting or blocking requests from this computer or "
    "network (IP block), so the transcript can't be fetched right now. Wait a "
    "few minutes and try again, or switch network / disable the VPN."
)
MSG_NO_CAPTIONS = (
    "This video has no usable captions (the creator turned them off or none "
    "exist) and speech-to-text is not available: the local Whisper model is not "
    "installed and no Groq API key was provided. Install it with "
    "'pip install -e .[whisper]' in lecture-notes-ai, add a Groq key in the "
    "settings, or choose a video that has captions."
)
MSG_NO_CAPTIONS_WHISPER_FAILED = "This video has no usable captions, and the speech-to-text fallback failed: {why}"
MSG_LIVE = (
    "This video is a live stream or premiere that hasn't finished yet. Try again once the recording is available."
)

# When every stage fails we show the message of the most "important" failure (higher wins).
FAILURE_PRIORITY = {"invalid": 6, "unavailable": 5, "age": 4, "live": 4, "blocked": 3, "nocaps": 1, "other": 0}
FAILURE_MESSAGES = {
    "invalid": MSG_INVALID,
    "unavailable": MSG_UNAVAILABLE,
    "age": MSG_AGE,
    "live": MSG_LIVE,
    "blocked": MSG_BLOCKED,
    "nocaps": MSG_NO_CAPTIONS,
    "other": "Couldn't fetch the transcript for this video. Please try again in a moment.",
}

# --------------------------------------------------------------------------- #
# 3. Internal signal between the fetch stages
# --------------------------------------------------------------------------- #


class StageFailure(Exception):
    """Internal: a single fetch stage failed.

    ``kind``   - a key of FAILURE_MESSAGES ("blocked", "nocaps", ...),
    ``detail`` - a short technical note (never shown raw to the user unless it is ours).
    """

    def __init__(self, kind: str, detail: str = ""):
        super().__init__(detail or kind)
        self.kind = kind
        self.detail = detail


# --------------------------------------------------------------------------- #
# 4. Understanding yt-dlp error text
# --------------------------------------------------------------------------- #


def ytdlp_error_kind(msg: str) -> str:
    """Map a raw yt-dlp error message to a failure kind ("age", "unavailable", "live", "blocked", "other")."""
    m = (msg or "").lower()
    if "age" in m and (
        "confirm your age" in m or "age-restricted" in m or "age restricted" in m or "inappropriate for some users" in m
    ):
        return "age"
    if (
        "private video" in m
        or "video unavailable" in m
        or "has been removed" in m
        or "this video is not available" in m
        or "members-only" in m
        or "members only" in m
        or "join this channel" in m
        or "terminated" in m
        or "does not exist" in m
        or "no longer available" in m
        or "blocked it in your country" in m
        or "not made this video available" in m
    ):
        return "unavailable"
    if "live event will begin" in m or "premieres in" in m or "is live" in m:
        return "live"
    # note: "and" binds tighter than "or" - the last test means ("rate" in m and "limit" in m)
    if "not a bot" in m or "429" in m or "too many requests" in m or "rate" in m and "limit" in m:
        return "blocked"
    return "other"


# --------------------------------------------------------------------------- #
# 5. Playlist messages
# --------------------------------------------------------------------------- #

MSG_NOT_PLAYLIST = (
    "That doesn't look like a YouTube playlist link. Paste a link such as "
    "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxx (or a video link that contains &list=...)."
)
MSG_PLAYLIST_MIX = (
    "That is a YouTube Mix (an auto-generated radio playlist). Mixes are different for every viewer, "
    "so they can't be imported. Open a real playlist and paste its link."
)
MSG_PLAYLIST_PRIVATE = (
    "This playlist is private (or needs a signed-in account), so it can't be imported. "
    "Ask the owner to set it to Unlisted or Public, then try again."
)
MSG_PLAYLIST_NOT_FOUND = "YouTube couldn't find that playlist. It may be private or deleted, or the link may be wrong."
MSG_PLAYLIST_BLOCKED = (
    "YouTube is rate-limiting requests from this computer or network right now. "
    "Wait a few minutes and try again, or switch network / disable the VPN."
)
MSG_PLAYLIST_OTHER = "Couldn't read that playlist from YouTube. Please try again in a moment."
