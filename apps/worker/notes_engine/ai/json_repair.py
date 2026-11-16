"""Turn messy model output into a Python dict/list.

Models are asked for JSON, but they sometimes wrap it in ```json fences, add a sentence
before it, leave a trailing comma, or get cut off half-way.  This file handles those cases:

1. ``parse_json()``             - the normal path: strip fences, find the outermost {...}, parse.
2. ``salvage_truncated_json()`` - for output cut off by the token limit: close the open
                                  brackets and drop the unfinished tail.

If both fail, ``llm._Client.ask_json`` asks the model once to fix its own JSON.

Read next: ``sections.py``.
"""

from __future__ import annotations

import json
import re
from typing import Any

# --------------------------------------------------------------------------- #
# 1. Small text helpers
# --------------------------------------------------------------------------- #


def strip_code_fences(text: str) -> str:
    """Remove a surrounding ```json ... ``` fence (also a lonely opening/closing fence)."""
    t = text.strip()
    m = re.match(r"^```[a-zA-Z0-9_-]*\s*\n?(.*?)\n?```\s*$", t, re.S)
    if m:
        return m.group(1).strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", t)
        t = re.sub(r"```\s*$", "", t)
    return t.strip()


def outermost_json(text: str) -> str | None:
    """Substring from the first '{' or '[' to its matching closer, or None.

    We walk the text character by character, keeping a stack of expected closers.  Brackets
    inside "strings" are ignored (``in_str``), and ``esc`` remembers a backslash escape.
    """
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        return None
    start = min(starts)
    stack: list[str] = []
    in_str = esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c in "{[":
            stack.append("}" if c == "{" else "]")
        elif c in "}]":
            if stack and stack[-1] == c:
                stack.pop()
                if not stack:
                    return text[start : i + 1]
            else:
                return None  # mismatched bracket: give up
    return None


def loads_lenient(s: str) -> Any:
    """``json.loads`` that allows control characters in strings and trailing commas."""
    try:
        return json.loads(s, strict=False)
    except json.JSONDecodeError:
        fixed = re.sub(r",\s*([}\]])", r"\1", s)  # trailing commas
        return json.loads(fixed, strict=False)


# --------------------------------------------------------------------------- #
# 2. Public parsers
# --------------------------------------------------------------------------- #


def parse_json(text: str) -> Any:
    """Parse model output into a dict/list: strips ``` fences, extracts the outermost {...}.

    Raises ValueError when no JSON object/array can be read.
    """
    if not text or not text.strip():
        raise ValueError("empty response")
    cleaned = strip_code_fences(text)
    candidates = [cleaned]
    outer = outermost_json(cleaned)
    if outer and outer != cleaned:
        candidates.append(outer)
    last: Exception | None = None
    for candidate in candidates:
        try:
            val = loads_lenient(candidate)
            if isinstance(val, (dict, list)):
                return val
        except json.JSONDecodeError as e:
            last = e
    raise ValueError(str(last) if last else "no JSON object found")


def salvage_truncated_json(text: str) -> Any:
    """Best-effort close of JSON cut off by an output limit (drops the dangling tail).

    Each round: count the still-open brackets/strings, close them, and try to parse.  If that
    fails, cut the text back to the previous comma and try again (at most 80 rounds).
    Raises ValueError when nothing usable is left.
    """
    s = strip_code_fences(text)
    start = min([i for i in (s.find("{"), s.find("[")) if i >= 0] or [-1])
    if start < 0:
        raise ValueError("no JSON found")
    s = s[start:]
    for _ in range(80):
        # (a) which brackets are still open at the end of s?
        stack: list[str] = []
        in_str = esc = False
        for c in s:
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c in "{[":
                stack.append("}" if c == "{" else "]")
            elif c in "}]" and stack:
                stack.pop()
        # (b) close the open string and brackets, then try to parse
        candidate = s + ('"' if in_str else "")
        candidate = re.sub(r",\s*$", "", candidate) + "".join(reversed(stack))
        try:
            val = loads_lenient(candidate)
            if isinstance(val, (dict, list)):
                return val
        except json.JSONDecodeError:
            pass
        # (c) did not parse: drop everything after the last comma and retry
        cut = s.rfind(",")
        if cut <= 0:
            break
        s = s[:cut]
    raise ValueError("could not salvage truncated JSON")
