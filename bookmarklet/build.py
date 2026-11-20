"""Print the bookmarklet URL: create a browser bookmark and paste this as its URL."""

import re
import urllib.parse
from pathlib import Path

src = (Path(__file__).parent / "linkedin_capture.js").read_text()
src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)  # block comments (incl. header)
code = " ".join(line.strip() for line in src.splitlines() if line.strip())
print("javascript:" + urllib.parse.quote(code, safe="(){}[];,.=!&|:+'\"<>?/\\*^$-_~"))
