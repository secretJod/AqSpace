import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.keycheck import check_keys  # noqa: E402

GOOD = "AIzaGOODVALUE123"


def run(env, caplog):
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="lna"):
        found = check_keys(env)
    return found, caplog.text


def test_good_keys_no_warning(caplog):
    env = {"GEMINI_API_KEY": GOOD, "GROQ_API_KEY": "gsk_abc", "NVIDIA_API_KEY": "nvapi-xyz"}
    found, text = run(env, caplog)
    assert found == {} and text == ""
    assert env["GEMINI_API_KEY"] == GOOD


def test_unset_or_blank_ignored(caplog):
    found, text = run({"GROQ_API_KEY": "  "}, caplog)
    assert found == {} and text == ""


def test_whitespace_and_quotes_stripped_and_warned_once(caplog):
    env = {"GEMINI_API_KEY": f'  "{GOOD}"\n'}
    found, text = run(env, caplog)
    assert env["GEMINI_API_KEY"] == GOOD
    assert "surrounding whitespace" in found["GEMINI_API_KEY"]
    assert "quotes" in found["GEMINI_API_KEY"]
    assert len(caplog.records) == 1


def test_inner_whitespace_and_prefix(caplog):
    env = {"GROQ_API_KEY": "gsk_ab cd", "NVIDIA_API_KEY": "sk-wrong"}
    found, _ = run(env, caplog)
    assert found["GROQ_API_KEY"] == ["inner whitespace"]
    assert found["NVIDIA_API_KEY"] == ["unexpected prefix (expected nvapi-...)"]


def test_never_logs_value_or_length(caplog):
    bad = "'SECRETVALUEXYZ 987'"
    _, text = run({"GEMINI_API_KEY": bad}, caplog)
    assert "GEMINI_API_KEY" in text
    for part in ("SECRET", "VALUE", "XYZ", "987", str(len(bad)), str(len(bad.strip("'")))):
        assert part not in text
