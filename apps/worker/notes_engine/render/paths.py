"""Where the renderer finds its files (fonts, CSS/JS templates, vendored Rough.js).

All paths are relative to the ``notes_engine`` package folder, so they work both from a source
checkout and from an installed package.
"""

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent  # .../notes_engine
FONT_DIR = PACKAGE_DIR / "static" / "fonts"
TEMPLATE_DIR = PACKAGE_DIR / "templates"  # notebook.css, notebook.js, vendor/rough.js
