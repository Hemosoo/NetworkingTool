"""Send by hand: open each approved email pre-filled in your own mail app, you click Send.

No passwords or SMTP needed. Each email is only marked sent after you confirm you sent it.
"""

from __future__ import annotations

import urllib.parse
import webbrowser
from typing import Any, Callable, Mapping

from .db import Store
from .finder import is_penn_email
from .sender import remaining_today

VIA_CHOICES = {
    "g": "gmail",
    "o": "outlook",
    "m": "mailto",
}
VIA_LABELS = {
    "gmail": "Gmail in your browser",
    "outlook": "Outlook in your browser",
    "mailto": "your default mail app (e.g. Apple Mail)",
}


def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def compose_url(via: str, to: str, subject: str, body: str, account: str = "") -> str:
    if via == "gmail":
        params = f"view=cm&fs=1&to={_q(to)}&su={_q(subject)}&body={_q(body)}"
        if account:
            # authuser picks the right Google account if you're signed into several.
            params = f"authuser={_q(account)}&" + params
        return "https://mail.google.com/mail/?" + params
    if via == "outlook":
        return (
            "https://outlook.office.com/mail/deeplink/compose?"
            f"to={_q(to)}&subject={_q(subject)}&body={_q(body)}"
        )
    if via == "mailto":
        return f"mailto:{_q(to)}?subject={_q(subject)}&body={_q(body)}"
    raise ValueError(f"Unknown mail app {via!r}; use gmail, outlook or mailto.")


def choose_via(ask: Callable[[str], str], out: Callable[[str], None]) -> str | None:
    out("Where do you send email from?")
    out("  [g] Gmail (web)   [o] Outlook (web)   [m] Mail app on this computer")
    out("  (Set `via = \"gmail\"` under [send] in config.toml to skip this question.)")
    answer = ask("> ").strip().lower()[:1]
    return VIA_CHOICES.get(answer)


def open_approved(
    store: Store,
    cfg: Mapping[str, Any],
    *,
    via: str | None = None,
    limit: int | None = None,
    ask: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
    opener: Callable[[str], Any] = webbrowser.open,
) -> dict[str, int]:
    tally = {"sent": 0, "skipped": 0, "declined": 0}
    queue = store.list(["approved"])
    if not queue:
        out("No approved emails waiting. Run `pennreach review` first.")
        return tally
    budget = remaining_today(store, cfg)
    if limit is not None:
        budget = min(budget, limit)
    if budget == 0:
        out(f"Daily cap of {cfg['limits']['max_per_day']} reached. Try again tomorrow.")
        return tally

    via = via or cfg.get("send", {}).get("via") or choose_via(ask, out)
    if via not in VIA_LABELS:
        out("No mail app chosen; nothing opened.")
        return tally
    account = cfg["me"].get("penn_email", "")
    out(f"\nOpening up to {min(budget, len(queue))} email(s) in {VIA_LABELS[via]}.")
    out("Read each one, click Send, then come back here and press y.\n")

    for c in queue:
        if tally["sent"] >= budget:
            out(f"Reached today's cap of {cfg['limits']['max_per_day']}. The rest can go tomorrow.")
            break
        email = (c["email"] or "").strip()
        if not is_penn_email(email):
            out(f"skip #{c['id']} {c['name']}: no valid Penn email")
            tally["skipped"] += 1
            continue
        blocked = store.email_blocked(email, exclude_id=c["id"])
        if blocked:
            out(f"skip #{c['id']} {c['name']}: {email} {blocked}")
            store.update(c["id"], status="declined", error=blocked)
            tally["declined"] += 1
            continue

        out(f"── #{c['id']} {c['name']} <{email}> ({c['firm']})")
        opener(compose_url(via, email, c["subject"], c["body"], account))
        while True:
            answer = ask("   [y] I sent it   [r] reopen   [s] skip for now   [d] decline   [q] quit > ")
            answer = answer.strip().lower()[:1]
            if answer == "y":
                store.mark_sent(c["id"])
                tally["sent"] += 1
                break
            if answer == "r":
                opener(compose_url(via, email, c["subject"], c["body"], account))
                continue
            if answer == "s":
                tally["skipped"] += 1
                break
            if answer == "d":
                store.update(c["id"], status="declined")
                tally["declined"] += 1
                break
            if answer == "q":
                return tally
            out("   Please choose y, r, s, d or q.")
    return tally
