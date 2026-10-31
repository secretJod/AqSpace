"""Long videos (R5, cards #36 and #33): 24 h transcripts, chunked speech-to-text with
checkpoints, and rendering of very long notes. No network, no model downloads."""
import copy
import json
import os
import re
import sys
import types
from pathlib import Path
from unittest import mock

import pytest
import requests

from notes_engine import ingest, pdf
from notes_engine.ingest import chunk_transcript, format_timestamp

VID = "dQw4w9WgXcQ"
SAMPLE = Path(__file__).with_name("sample_notes.json")
DAY = 24 * 3600


# --------------------------------------------------------------------------- #
# timestamps over 24 h
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("sec,want", [
    (0, "00:00"), (59.9, "00:59"), (3599, "59:59"), (3600, "1:00:00"),
    (9 * 3600 + 59 * 60 + 59, "9:59:59"), (10 * 3600, "10:00:00"),
    (DAY - 1, "23:59:59"), (DAY, "24:00:00"), (25 * 3600 + 61, "25:01:01"),
])
def test_format_timestamp_any_hours(sec, want):
    assert format_timestamp(sec) == want


def _day_transcript(step=20.0, hours=24):
    n = int(hours * 3600 / step)
    segs = [{"start": i * step, "text": f"sentence number {i} about topic {i // 90}."} for i in range(n)]
    return {"segments": segs, "duration_sec": hours * 3600}


def _marker_seconds(text):
    out = []
    for m in re.finditer(r"\[(?:(\d+):)?(\d{2}):(\d{2})\]", text):
        out.append(int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3)))
    return out


def test_chunk_transcript_24h_markers_and_bounds():
    t = _day_transcript()
    chunks = chunk_transcript(t, max_chars=12000, overlap_chars=400)
    assert len(chunks) > 10
    assert [c["index"] for c in chunks] == list(range(len(chunks)))
    prev_start = -1.0
    for c in chunks:
        assert len(c["text"]) <= 12000
        assert c["text"].startswith("[")
        secs = _marker_seconds(c["text"])
        assert secs and secs == sorted(secs)
        assert c["start"] <= secs[0] + 0.01 and secs[-1] <= c["end"]
        assert c["start"] >= prev_start
        prev_start = c["start"]
    # the last chunk reaches the end of the day and uses h:mm:ss with two-digit hours
    assert chunks[-1]["end"] == DAY
    assert "[23:" in chunks[-1]["text"]
    assert any(re.search(r"\[1\d:\d\d:\d\d\]", c["text"]) for c in chunks)
    # every segment's text survives chunking
    joined = " ".join(c["text"] for c in chunks)
    assert "sentence number 0 about" in joined and f"sentence number {len(t['segments']) - 1} about" in joined


# --------------------------------------------------------------------------- #
# streamed caption download with retries
# --------------------------------------------------------------------------- #

class _Resp:
    def __init__(self, status=200, body=b""):
        self.status_code = status
        self._body = body

    def iter_content(self, chunk_size=1):
        return [self._body[i:i + 5] for i in range(0, len(self._body), 5)]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_download_streams_to_disk_and_retries(tmp_path):
    calls = []

    def fake_get(url, timeout=None, stream=False):
        calls.append((timeout, stream))
        if len(calls) == 1:
            raise requests.Timeout("slow")
        if len(calls) == 2:
            return _Resp(503)
        return _Resp(200, b'{"events": []}')

    sleeps = []
    with mock.patch.object(ingest.requests, "get", fake_get):
        out = ingest._download_to_file("https://www.youtube.com/x", str(tmp_path / "s.json"), sleep=sleeps.append)
    assert Path(out).read_bytes() == b'{"events": []}'
    assert len(calls) == 3 and all(s for _, s in calls)
    assert calls[0][0] == ingest._DOWNLOAD_TIMEOUT and ingest._DOWNLOAD_TIMEOUT[1] >= 120
    assert sleeps == [1.5, 3.0]


def test_download_429_everywhere_is_blocked(tmp_path):
    with mock.patch.object(ingest.requests, "get", lambda *a, **k: _Resp(429)):
        with pytest.raises(ingest._Fail) as ei:
            ingest._download_to_file("u", str(tmp_path / "s"), sleep=lambda s: None)
    assert ei.value.kind == "blocked"


def test_download_size_cap(tmp_path):
    with mock.patch.object(ingest.requests, "get", lambda *a, **k: _Resp(200, b"x" * 100)):
        with pytest.raises(ingest._Fail) as ei:
            ingest._download_to_file("u", str(tmp_path / "s"), max_bytes=50, sleep=lambda s: None)
    assert "too large" in ei.value.detail


def test_ytdlp_options_suit_long_videos():
    c = ingest._YTDLP_COMMON
    assert c["socket_timeout"] >= 60 and c["retries"] >= 5 and c["fragment_retries"] >= 5
    assert ingest.MAX_AUDIO_BYTES >= 1024 ** 3


# --------------------------------------------------------------------------- #
# ffmpeg split (faked) uses the exact segment list offsets
# --------------------------------------------------------------------------- #

def test_split_audio_reads_segment_list(tmp_path):
    seen = {}

    def fake_run(cmd, capture_output=True, timeout=None):
        seen["cmd"], seen["timeout"] = cmd, timeout
        out = Path(cmd[-1]).parent
        rows = []
        for i in range(3):
            (out / f"chunk_{i:04d}.mp3").write_bytes(b"x")
            rows.append(f"chunk_{i:04d}.mp3,{i * 600.25:.6f},{(i + 1) * 600.25:.6f}")
        (out / "segments.csv").write_text("\n".join(rows) + "\n")
        return types.SimpleNamespace(returncode=0, stderr=b"")

    with mock.patch.object(ingest.subprocess, "run", fake_run):
        chunks = ingest._split_audio("ffmpeg", "audio.webm", str(tmp_path / "chunks"))
    assert [round(o, 2) for _, o in chunks] == [0.0, 600.25, 1200.5]
    assert "-segment_list" in seen["cmd"] and seen["timeout"] >= 3600


# --------------------------------------------------------------------------- #
# chunked speech-to-text with a checkpoint per chunk
# --------------------------------------------------------------------------- #

class FakeTranscriber:
    name = "fake"

    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on

    def transcribe(self, path):
        name = os.path.basename(path)
        self.calls.append(name)
        if name == self.fail_on:
            raise ingest._Fail("other", "killed")
        i = int(name[6:10])
        return [{"start": 1.0, "end": 4.0, "text": f"chunk {i} starts here."},
                {"start": 30.0, "end": 33.0, "text": f"chunk {i} ends here."},
                {"start": 40.0, "end": 41.0, "text": "noise", "no_speech_prob": 0.99}], "english"


@pytest.fixture
def fake_audio(monkeypatch):
    """Fake download + split: 144 chunks of 10 min = 24 h."""
    state = {"downloads": 0, "splits": 0}

    def dl(video_id, out_dir, cache):
        state["downloads"] += 1
        p = os.path.join(out_dir, "audio.webm")
        Path(p).write_bytes(b"a")
        return p

    def split(ffmpeg, src, out_dir):
        state["splits"] += 1
        os.makedirs(out_dir, exist_ok=True)
        for i in range(144):
            Path(out_dir, f"chunk_{i:04d}.mp3").write_bytes(b"x")
        return ingest._read_segment_list(out_dir)

    monkeypatch.setattr(ingest, "_download_audio", dl)
    monkeypatch.setattr(ingest, "_split_audio", split)
    monkeypatch.setattr(ingest, "_find_ffmpeg", lambda: "ffmpeg")
    return state


def test_whisper_resumes_from_checkpoints(tmp_path, fake_audio):
    work = str(tmp_path)
    first = FakeTranscriber(fail_on="chunk_0070.mp3")
    with pytest.raises(ingest._Fail):
        ingest._fetch_via_whisper(VID, first, {}, None, work)
    assert len(first.calls) == 71
    done = sorted(os.listdir(os.path.join(work, VID, "stt", "done")))
    assert len(done) == 70 and done[0] == "chunk_0000.json"
    assert not os.path.exists(os.path.join(work, VID, "stt", "audio.webm"))  # freed after the split

    second = FakeTranscriber()
    segs, lang, source, est = ingest._fetch_via_whisper(VID, second, {}, None, work)
    assert second.calls[0] == "chunk_0070.mp3" and len(second.calls) == 74  # resumed, no redo
    assert fake_audio == {"downloads": 1, "splits": 1}
    assert source == "whisper" and lang == "en"
    starts = [s["start"] for s in segs]
    assert starts == sorted(starts)
    assert starts[-1] >= 143 * 600 and est <= DAY
    assert not any("noise" in s["text"] for s in segs)
    last = [s for s in segs if "chunk 143" in s["text"]][0]
    assert format_timestamp(last["start"]).startswith("23:50")

    third = FakeTranscriber()
    again = ingest._fetch_via_whisper(VID, third, {}, None, work)
    assert third.calls == [] and again[0] == segs  # transcript.json short-circuits
    assert not os.path.exists(os.path.join(work, VID, "stt", "chunks"))


def test_whisper_refuses_over_24h(tmp_path, fake_audio):
    with pytest.raises(ingest._Fail) as ei:
        ingest._fetch_via_whisper(VID, FakeTranscriber(), {"info": {"duration": 30 * 3600}}, None, str(tmp_path))
    assert "24 hours" in ei.value.detail and fake_audio["downloads"] == 0


def test_corrupt_checkpoint_is_redone(tmp_path, fake_audio):
    work = str(tmp_path)
    t = FakeTranscriber(fail_on="chunk_0002.mp3")
    with pytest.raises(ingest._Fail):
        ingest._fetch_via_whisper(VID, t, {}, None, work)
    Path(work, VID, "stt", "done", "chunk_0001.json").write_text("{broken")
    t2 = FakeTranscriber()
    ingest._fetch_via_whisper(VID, t2, {}, None, work)
    assert t2.calls[:2] == ["chunk_0001.mp3", "chunk_0002.mp3"]


def test_pick_transcriber_modes(monkeypatch):
    monkeypatch.delenv("LNAI_WHISPER", raising=False)
    monkeypatch.setattr(ingest, "_local_whisper_available", lambda: True)
    assert isinstance(ingest._pick_transcriber(None), ingest.LocalWhisperTranscriber)
    assert isinstance(ingest._pick_transcriber("k"), ingest.LocalWhisperTranscriber)  # local first
    monkeypatch.setenv("LNAI_WHISPER", "groq")
    assert isinstance(ingest._pick_transcriber("k"), ingest.GroqTranscriber)
    monkeypatch.setenv("LNAI_WHISPER", "off")
    assert ingest._pick_transcriber("k") is None
    monkeypatch.setenv("LNAI_WHISPER", "auto")
    monkeypatch.setattr(ingest, "_local_whisper_available", lambda: False)
    assert isinstance(ingest._pick_transcriber("k"), ingest.GroqTranscriber)
    assert ingest._pick_transcriber(None) is None


def test_local_whisper_uses_cpu_int8_and_repo_model_dir(monkeypatch, tmp_path):
    made = {}

    class FakeModel:
        def __init__(self, name, **kw):
            made["name"], made["kw"] = name, kw

        def transcribe(self, path, **kw):
            made["tkw"] = kw
            seg = types.SimpleNamespace(start=0.5, end=2.0, text=" hello", no_speech_prob=0.1)
            return iter([seg]), types.SimpleNamespace(language="en")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeModel))
    monkeypatch.delenv("LNAI_WHISPER_MODEL", raising=False)
    t = ingest.LocalWhisperTranscriber(model_dir=str(tmp_path / "m"))
    segs, lang = t.transcribe("chunk_0000.mp3")
    assert segs == [{"start": 0.5, "end": 2.0, "text": " hello", "no_speech_prob": 0.1}] and lang == "en"
    assert made["name"] == "small"
    assert made["kw"]["device"] == "cpu" and made["kw"]["compute_type"] == "int8"
    assert made["kw"]["download_root"] == str(tmp_path / "m")
    assert made["tkw"]["vad_filter"] is True
    # default model dir is repo-local and covered by .gitignore/.tools + nuke.sh
    assert ingest.WHISPER_MODEL_DIR.endswith(os.path.join(".tools", "whisper-models"))


def test_local_whisper_errors_are_friendly(monkeypatch):
    class Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("secret internals")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=Boom))
    with pytest.raises(ingest._Fail) as ei:
        ingest.LocalWhisperTranscriber(model_dir="/nonexistent-but-unused").transcribe("x")
    assert "local Whisper failed" in ei.value.detail and "secret" not in ei.value.detail


def test_get_transcript_uses_local_whisper_and_work_dir(monkeypatch, tmp_path):
    got = {}

    def fake_whisper(video_id, transcriber, cache, progress, work_dir):
        got["t"], got["w"] = transcriber, work_dir
        return [{"start": 36000.0, "text": "ten hours in"}], "en", "whisper", 36005.0

    monkeypatch.setattr(ingest, "_get_metadata", lambda v, c: ("T", "C", None))
    monkeypatch.setattr(ingest, "_fetch_via_api", lambda v: (_ for _ in ()).throw(ingest._Fail("nocaps")))
    monkeypatch.setattr(ingest, "_fetch_via_ytdlp", lambda v, c: (_ for _ in ()).throw(ingest._Fail("nocaps")))
    monkeypatch.setattr(ingest, "_local_whisper_available", lambda: True)
    monkeypatch.setattr(ingest, "_fetch_via_whisper", fake_whisper)
    monkeypatch.delenv("LNAI_WHISPER", raising=False)
    t = ingest.get_transcript(VID, work_dir=str(tmp_path))  # no Groq key needed
    assert isinstance(got["t"], ingest.LocalWhisperTranscriber) and got["w"] == str(tmp_path)
    assert t["source"] == "whisper" and t["duration_sec"] == 36005


def test_default_work_dir_is_repo_local_and_ignored():
    root = Path(ingest._REPO_ROOT)
    assert Path(ingest.DEFAULT_WORK_DIR).is_relative_to(root / "lecture-notes-ai" / "backend" / "output")
    nuke = (root / "scripts" / "nuke.sh").read_text()
    assert ".tools" in nuke and "lecture-notes-ai/backend/output" in nuke


# --------------------------------------------------------------------------- #
# rendering very long notes (#33)
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def base_notes():
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def _long_notes(base, n=80):
    notes = copy.deepcopy(base)
    tmpl = base["sections"]
    secs = []
    for i in range(n):
        s = copy.deepcopy(tmpl[i % len(tmpl)])
        s["number"] = i + 2
        s["title"] = f"part {i + 2}: topic {i}"
        s["timestamp"] = format_timestamp(i * DAY / n)
        if i % 3:  # keep the PDF size reasonable: only some sections carry diagrams
            s.pop("diagram", None)
        secs.append(s)
    notes["sections"] = secs
    notes["cover"]["toc"] = []
    notes["meta"]["duration"] = "24:00:00"
    return notes


def test_long_notes_get_full_contents(base_notes):
    notes = _long_notes(base_notes, 80)
    h = pdf.render_html(notes)
    assert h.count('data-kind="contents"') == 1
    toc = h.split('data-kind="contents"')[1].split('data-kind="section"')[0]
    for i in range(80):
        assert f"part {i + 2}: topic {i}" in toc
    assert "◷ 23:42:00" in toc and "◷ 10:" in toc  # timestamps over 10 h
    assert "and 63 more" in h  # cover lists 17 and points to the contents pages
    assert h.count('data-kind="section"') == 80


def test_short_notes_have_no_contents_unit(base_notes):
    assert 'data-kind="contents"' not in pdf.render_html(base_notes)


def test_render_is_provider_independent(base_notes):
    a = copy.deepcopy(base_notes)
    b = copy.deepcopy(base_notes)
    a["meta"]["model"] = "local/qwen3-8b"
    b["meta"]["model"] = "groq/llama-3.3-70b-versatile"
    assert pdf.render_html(a) == pdf.render_html(b)


def test_render_budgets_scale_with_sections():
    (f1, s1), t1 = pdf._render_budgets(9)
    (f2, s2), t2 = pdf._render_budgets(80)
    assert (f1, s1, t1) == (20000, 60000, 180)
    assert f2 > f1 and s2 > s1 and t2 > t1
    assert t2 <= 900 and s2 <= 300000


def _have_browser():
    try:
        pdf._find_browser()
        import pymupdf  # noqa: F401
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _have_browser(), reason="Edge/Chrome or pymupdf not installed")
def test_pdf_of_40_section_notes(tmp_path, base_notes):
    import pymupdf

    notes = _long_notes(base_notes, 40)
    out = pdf.render_pdf(notes, str(tmp_path / "long.pdf"))
    doc = pymupdf.open(out)
    n = len(doc)
    texts = [p.get_text() for p in doc]
    doc.close()
    assert n > 40
    for i, t in enumerate(texts, 1):
        assert re.search(r"pg\.\s*%d\s*/\s*%d" % (i, n), t)
    full = "\n".join(texts)
    assert "part 41: topic 39" in full and "23:24:00" in full
    contents = [t for t in texts[1:4] if "contents" in t]
    assert contents and re.search(r"p\.\s*\d+", contents[0])
