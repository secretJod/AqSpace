"""Package layout: helpers in ai/, render/ and transcripts/ stay reachable through llm, ingest and
pdf, and the cover summary is never cut mid-sentence."""

import copy
import json
from pathlib import Path

from notes_engine import ingest, llm, pdf
from notes_engine.ai import errors, providers, sections
from notes_engine.render import cover, pdf_export, text
from notes_engine.transcripts import errors as ingest_errors
from notes_engine.transcripts import youtube_urls

SAMPLE = Path(__file__).with_name("sample_notes.json")


def test_llm_reexports_point_at_the_ai_package():
    assert llm.LLMError is errors.LLMError
    assert llm._TransientError is errors._TransientError
    assert issubclass(llm._TransientError, llm.LLMError)
    assert llm.PROVIDERS is providers.PROVIDERS
    assert llm._profile is providers.model_profile
    assert llm.local_profile_name is providers.local_profile_name
    assert llm._usable_count is sections.usable_section_count


def test_local_provider_and_profiles_live_in_ai_providers():
    assert list(providers.PROVIDERS)[0] == "local" and providers.PROVIDERS["local"]["needs_key"] is False
    assert providers.PROVIDERS["colab"]["alias_of"] == "local"
    big, small = providers.model_profile("local", "qwen3-8b"), providers.model_profile("local-small", "qwen3-8b")
    assert big["max_total_sections"] == 200 and big["read_timeout"] == providers.LOCAL_READ_TIMEOUT
    assert small["ctx_tokens"] == 8192 and small["chunk_chars"] < big["chunk_chars"]
    assert providers.model_profile("gemini", "gemini-3.5-flash-lite")["max_total_sections"] == 18
    assert providers.local_profile_name(8192) == "local-small" and providers.local_profile_name(16384) == "local"


def test_ingest_exposes_transcriber_names_and_messages():
    assert ingest.MSG_CHANNEL is ingest_errors.MSG_CHANNEL
    assert ingest.parse_video_id is youtube_urls.parse_video_id
    for name in (
        "LocalWhisperTranscriber",
        "GroqTranscriber",
        "_pick_transcriber",
        "_download_to_file",
        "DEFAULT_WORK_DIR",
        "WHISPER_MODEL_DIR",
        "MAX_VIDEO_SECONDS",
    ):
        assert hasattr(ingest, name), name
    assert "speech-to-text is not available" in ingest.MSG_NO_CAPTIONS


def test_pdf_keeps_long_notes_helpers():
    assert pdf._render_budgets is pdf_export.render_budgets
    assert pdf.COVER_TOC_MAX == cover.COVER_TOC_MAX == 18
    assert "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" in pdf_export.KNOWN_BROWSER_PATHS


# ---------------------------------------------------------------- cover summary ends on a sentence
def test_truncate_sentences_ends_on_a_whole_sentence():
    s = (
        "Higher order derivatives measure how a rate of change itself changes. The second derivative is "
        "the derivative of the derivative. Physically it is acceleration, and the third derivative as "
        "jerk is rarely needed in practice."
    )
    out = text.truncate_sentences(s, 200)
    assert out.endswith("derivative of the derivative.")
    assert len(out) <= 200
    assert text.truncate_sentences("short one.", 200) == "short one."


def test_truncate_sentences_falls_back_to_a_word_boundary():
    out = text.truncate_sentences("word " * 80, 60)
    assert out.endswith("…") and len(out) <= 60 and not out[:-1].endswith(" ")


def test_cover_summary_is_never_cut_mid_sentence():
    notes = json.loads(SAMPLE.read_text(encoding="utf-8"))
    notes = copy.deepcopy(notes)
    notes["cover"]["summary"] = (
        "This lecture explains the second derivative. " * 3
        + "It then covers higher order derivatives as a way of seeing the second derivative as acceleration."
    )
    html = pdf.render_html(notes)
    summary = html.split('<div class="cv-sum">', 1)[1].split("</div>", 1)[0]
    assert summary.endswith(".") and "the second derivative as" not in summary[-30:]
