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


# ---- Bookmarklet-assisted lookup ------------------------------------------------------------
# `lookup-list` hands the pending names to the Penn Directory bookmarklet, which runs the searches
# inside your own logged-in browser session and downloads penn_emails.csv; `import-emails` reads
# that file back, auto-filling unique matches and asking only when there's a real choice.


def lookup_list(store: Store) -> str:
    """Compact JSON [[id, first, last], ...] of contacts still missing an email."""
    import json

    from .parsing import clean_name

    people = []
    for c in store.list(["new"]):
        parts = clean_name(c["name"]).split()
        if len(parts) >= 2 and not parts[-1].endswith("."):  # skip "Jane D." style names
            people.append([c["id"], parts[0], parts[-1]])
    return json.dumps(people, ensure_ascii=False, separators=(",", ":"))


def _directory_first_name(dir_name: str) -> str:
    # "Doe, Jane Marie" -> "jane"
    _, _, rest = dir_name.partition(",")
    return (rest.split() or [""])[0].lower()


def import_directory_results(
    store: Store,
    path: str,
    *,
    ask: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
) -> dict[str, int]:
    import csv

    tally = {"filled": 0, "chosen": 0, "no_match": 0, "skipped": 0}
    by_contact: dict[int, list[dict[str, str]]] = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            try:
                cid = int(row["contact_id"])
            except (KeyError, ValueError):
                continue
            by_contact.setdefault(cid, [])
            if row.get("directory_name"):
                by_contact[cid].append(row)

    listings = sum(len(v) for v in by_contact.values())
    with_email = sum(1 for v in by_contact.values() for r in v if r.get("email"))
    if listings and not with_email:
        out("None of the directory listings had an email. You probably weren't logged in.\n"
            "Log in to the Penn Directory with your PennKey and run the bookmarklet again.")
        return tally

    for cid, rows in by_contact.items():
        c = store.get(cid)
        if c is None or c["status"] != "new":
            continue
        first = (c["name"].split() or [""])[0].lower()
        candidates = []
        for r in rows:
            for email in (r.get("email") or "").split():
                if is_penn_email(email):
                    candidates.append((r, email.lower()))
        # Prefer listings whose first name matches what's on LinkedIn.
        exact = [(r, e) for r, e in candidates if _directory_first_name(r["directory_name"]) == first]
        if len({e for _, e in exact}) == 1:
            candidates = exact
        options: list[tuple[dict[str, str], str]] = []
        for r, e in candidates:  # one option per distinct email, in directory order
            if e not in {oe for _, oe in options}:
                options.append((r, e))

        if not candidates:
            out(f"#{cid} {c['name']}: no listing with an email; use `find-emails` for this one.")
            tally["no_match"] += 1
            continue
        if len(options) == 1:
            chosen_row, email = options[0]
        else:
            out(f"\n#{cid} {c['name']} ({c['headline'] or c['firm']}): several matches")
            for i, (r, e) in enumerate(options, 1):
                out(f"  {i}. {r['directory_name']} — {r['affiliation']} — {e}")
            answer = ask("  pick a number, or [s]kip > ").strip().lower()
            if not answer.isdigit() or not 1 <= int(answer) <= len(options):
                tally["skipped"] += 1
                continue
            chosen_row, email = options[int(answer) - 1]
            tally["chosen"] += 1
        blocked = store.email_blocked(email, exclude_id=cid)
        if blocked:
            out(f"#{cid} {c['name']}: {email} is {blocked}; skipping.")
            tally["skipped"] += 1
            continue
        store.update(cid, email=email, email_source="penn_directory", status="ready")
        out(f"#{cid} {c['name']} → {email}  ({chosen_row['directory_name']})")
        tally["filled"] += 1
    return tally
