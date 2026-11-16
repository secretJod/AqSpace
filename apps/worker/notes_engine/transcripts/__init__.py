"""Building blocks for getting a lecture transcript from YouTube.

What lives here
---------------
* ``errors.py``        - ``IngestError`` / ``PlaylistError`` and every user-facing message.
* ``youtube_urls.py``  - checking a YouTube link and pulling out the video / playlist id.
* ``cleaning.py``      - caption text cleaning: remove [Music] cues, rolling duplicates, merge
                         tiny cues into ~5-15 s segments; parse json3 / vtt subtitle files.
* ``chunking.py``      - cut a transcript into LLM-sized pieces with [mm:ss] markers.
* ``playlists.py``     - list the videos of a YouTube playlist.

How it fits
-----------
``notes_engine/ingest.py`` is the public module: ``get_transcript`` and the three fetch stages
live there (tests patch them on ``ingest``), and it re-exports the names callers need
(``parse_video_id``, ``get_playlist``, ``chunk_transcript``, ...).

Read next: ``youtube_urls.py`` -> ``cleaning.py`` -> ``chunking.py`` -> ``../ingest.py``.
"""
