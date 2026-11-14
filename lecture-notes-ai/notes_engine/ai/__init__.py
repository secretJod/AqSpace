"""Building blocks of the AI (LLM) engine.

What lives here
---------------
Small, self-contained helpers that ``notes_engine/llm.py`` is built from.  None of them
talk to the network or sleep, so each file can be read (and tested) on its own:

* ``errors.py``       - the exception classes (``LLMError`` and its private friends).
* ``providers.py``    - the list of AI providers, their URLs and the per-model size "profile".
* ``key_safety.py``   - cleaning a pasted API key and scrubbing keys out of error text.
* ``responses.py``    - reading provider replies: retry hints, quota hints, small type guards.
* ``json_repair.py``  - turning messy model output into a Python dict/list.
* ``sections.py``     - finding, merging and counting notebook sections in model answers.

How it fits
-----------
``notes_engine/llm.py`` is still the public entry point (``generate_notes``) and it re-exports
every name it used to define, so ``from notes_engine.llm import X`` keeps working.  The HTTP
client, the rate-limit pacer and the pipeline stay in ``llm.py`` because tests patch
``llm._sleep`` / ``llm._get_chunker`` there.

Read next: ``providers.py`` -> ``json_repair.py`` -> ``sections.py`` -> ``../llm.py``.
"""
