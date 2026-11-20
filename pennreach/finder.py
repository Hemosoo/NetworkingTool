"""Finding Penn emails.

Penn student addresses are PennKey-based (e.g. jdoe@wharton.upenn.edu, jsmith22@seas.upenn.edu)
and can't be reliably guessed from a name — a wrong guess emails a stranger. The Penn Directory
is the source of truth, so this walks you through looking each person up (one at a time, only
for people you actually intend to contact) and validates what you paste.
"""

from __future__ import annotations

import re
import urllib.parse
import webbrowser
from typing import Callable

from .db import Store

PENN_DIRECTORY_URL = "https://directory.apps.upenn.edu/directory/jsp/fast.do"

PENN_EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*upenn\.edu$", re.I)
_EMAIL_IN_TEXT_RE = re.compile(r"[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*upenn\.edu", re.I)


def is_penn_email(email: str) -> bool:
    return bool(PENN_EMAIL_RE.match((email or "").strip()))


def extract_penn_email(text: str) -> str | None:
    """Pull a Penn address out of whatever was pasted (e.g. a whole directory row)."""
    m = _EMAIL_IN_TEXT_RE.search(text or "")
    return m.group(0).lower() if m else None


def google_search_url(name: str, firm: str) -> str:
    q = f'"{name}" upenn.edu {firm}'.strip()
    return "https://www.google.com/search?q=" + urllib.parse.quote_plus(q)


def find_emails(
    store: Store,
    *,
    open_browser: bool = False,
    ask: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
) -> int:
    """Interactive loop over contacts missing an email. Returns how many were filled in."""
    pending = store.list(["new"])
    if not pending:
        out("No contacts are waiting for an email. 🎉")
        return 0
    out(f"{len(pending)} contact(s) need a Penn email.")
    out(f"Look each one up in the Penn Directory: {PENN_DIRECTORY_URL}")
    out("Paste the email (or the whole directory row), [s]kip, or [q]uit.\n")
    if open_browser:
        webbrowser.open(PENN_DIRECTORY_URL)

    filled = 0
    for c in pending:
        out(f"── #{c['id']} {c['name']} — {c['headline'] or c['firm']}")
        if c["linkedin_url"]:
            out(f"   LinkedIn: {c['linkedin_url']}")
        out(f"   Web search: {google_search_url(c['name'], c['firm'])}")
        while True:
            answer = ask("   email> ").strip()
            if answer.lower() in {"q", "quit"}:
                return filled
            if answer.lower() in {"s", "skip", ""}:
                break
            email = extract_penn_email(answer)
            if not email:
                out("   That doesn't look like a @upenn.edu address — try again, or [s]kip.")
                continue
            blocked = store.email_blocked(email, exclude_id=c["id"])
            if blocked:
                out(f"   {email} is {blocked}; skipping this contact.")
                break
            store.update(c["id"], email=email, email_source="penn_directory", status="ready")
            filled += 1
            break
    return filled
