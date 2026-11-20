"""Print bookmarklet URLs. Create a browser bookmark for each and paste the line as its URL.

    python3 bookmarklet/build.py            # both bookmarklets
    python3 bookmarklet/build.py linkedin   # just one (linkedin | directory)
"""

import re
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).parent
BOOKMARKLETS = {
    "linkedin": ("PennReach: LinkedIn capture", "linkedin_capture.js"),
    "directory": ("PennReach: Penn Directory lookup", "penn_directory_lookup.js"),
}


def build(filename: str) -> str:
    src = (HERE / filename).read_text()
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)  # block comments (incl. header)
    lines = (line.strip() for line in src.splitlines())
    # Drop blank lines and whole-line // comments (they would swallow everything once joined).
    code = " ".join(line for line in lines if line and not line.startswith("//"))
    return "javascript:" + urllib.parse.quote(code, safe="(){}[];,.=!&|:+'\"<>?/\\*^$-_~")


def main() -> None:
    wanted = sys.argv[1:] or list(BOOKMARKLETS)
    for key in wanted:
        title, filename = BOOKMARKLETS[key]
        if len(wanted) > 1:
            print(f"\n=== {title} (bookmark name suggestion) ===")
        print(build(filename))


if __name__ == "__main__":
    main()
