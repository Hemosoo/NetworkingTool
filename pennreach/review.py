"""Interactive accept/decline queue for drafted emails."""

from __future__ import annotations

import os
import shlex
import subprocess
import tempfile
from typing import Callable

from .db import Store

DIVIDER = "─" * 72


def _edit_in_editor(subject: str, body: str) -> tuple[str, str]:
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "nano"
    with tempfile.NamedTemporaryFile("w+", suffix=".txt", delete=False) as fh:
        fh.write(f"Subject: {subject}\n\n{body}")
        path = fh.name
    try:
        subprocess.run([*shlex.split(editor), path], check=True)
        with open(path) as fh:
            text = fh.read()
    finally:
        os.unlink(path)
    head, _, new_body = text.partition("\n\n")
    new_subject = head.removeprefix("Subject:").strip() or subject
    return new_subject, new_body.strip("\n") + "\n"


def review(
    store: Store,
    *,
    ask: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
    editor: Callable[[str, str], tuple[str, str]] = _edit_in_editor,
) -> dict[str, int]:
    tally = {"approved": 0, "declined": 0, "skipped": 0}
    drafts = store.list(["drafted"])
    if not drafts:
        out("Nothing to review. Run `pennreach draft` first.")
        return tally

    for i, c in enumerate(drafts, 1):
        subject, body = c["subject"], c["body"]
        while True:
            out(DIVIDER)
            out(f"[{i}/{len(drafts)}] #{c['id']} {c['name']} — {c['firm']} ({c['headline']})")
            out(f"To: {c['email']}")
            out(f"Subject: {subject}\n")
            out(body)
            out(DIVIDER)
            choice = ask("[a]pprove  [d]ecline  [e]dit  [s]kip  [q]uit > ").strip().lower()
            if choice in {"a", "approve", "y"}:
                store.update(c["id"], status="approved", subject=subject, body=body)
                tally["approved"] += 1
                break
            if choice in {"d", "decline", "n"}:
                store.update(c["id"], status="declined")
                tally["declined"] += 1
                break
            if choice in {"e", "edit"}:
                subject, body = editor(subject, body)
                store.update(c["id"], subject=subject, body=body)
                continue
            if choice in {"s", "skip", ""}:
                tally["skipped"] += 1
                break
            if choice in {"q", "quit"}:
                return tally
            out("Please choose a, d, e, s or q.")
    return tally
