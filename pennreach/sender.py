"""Send approved emails over SMTP with a daily cap and human-paced delays."""

from __future__ import annotations

import datetime as dt
import os
import random
import smtplib
import time
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Callable, Mapping, Protocol

from .db import Store, now
from .finder import is_penn_email

PASSWORD_ENV = "PENNREACH_SMTP_PASSWORD"


class Transport(Protocol):
    def send(self, msg: EmailMessage) -> None: ...
    def close(self) -> None: ...


class SMTPTransport:
    def __init__(self, smtp_cfg: Mapping[str, Any]):
        password = os.environ.get(PASSWORD_ENV)
        if not password:
            raise RuntimeError(
                f"Set {PASSWORD_ENV} to your SMTP / app password before sending live."
            )
        host, port = smtp_cfg["host"], int(smtp_cfg["port"])
        if smtp_cfg.get("use_ssl"):
            self.server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=30)
        else:
            self.server = smtplib.SMTP(host, port, timeout=30)
            self.server.starttls()
        self.server.login(smtp_cfg["username"], password)

    def send(self, msg: EmailMessage) -> None:
        self.server.send_message(msg)

    def close(self) -> None:
        try:
            self.server.quit()
        except smtplib.SMTPException:
            pass


def build_message(me: Mapping[str, Any], to: str, subject: str, body: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr((me["name"], me["penn_email"]))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=me["penn_email"].split("@")[-1])
    msg.set_content(body)
    return msg


def remaining_today(store: Store, cfg: Mapping[str, Any]) -> int:
    used = store.sent_since(now() - dt.timedelta(hours=24))
    return max(0, int(cfg["limits"]["max_per_day"]) - used)


def send_approved(
    store: Store,
    cfg: Mapping[str, Any],
    *,
    live: bool,
    limit: int | None = None,
    transport_factory: Callable[[], Transport] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    out: Callable[[str], None] = print,
) -> dict[str, int]:
    tally = {"sent": 0, "failed": 0, "skipped": 0, "dry_run": 0}
    me = cfg["me"]
    if not is_penn_email(me.get("penn_email", "")):
        raise ValueError("Set [me].penn_email in config.toml to your @upenn.edu address.")

    queue = store.list(["approved"])
    budget = remaining_today(store, cfg)
    if limit is not None:
        budget = min(budget, limit)
    if not queue:
        out("No approved emails waiting. Run `pennreach review` (or `auto`).")
        return tally
    if budget == 0:
        out(f"Daily cap of {cfg['limits']['max_per_day']} reached — try again tomorrow.")
        return tally

    transport: Transport | None = None
    if live:
        transport = (transport_factory or (lambda: SMTPTransport(cfg["smtp"])))()
    lo, hi = cfg["limits"]["min_delay_seconds"], cfg["limits"]["max_delay_seconds"]
    try:
        sent_any = False
        for c in queue:
            if tally["sent"] + tally["dry_run"] >= budget:
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
                tally["skipped"] += 1
                continue

            msg = build_message(me, email, c["subject"], c["body"])
            if not live:
                out(f"[dry run] would send to {c['name']} <{email}> — {c['subject']!r}")
                tally["dry_run"] += 1
                continue

            if sent_any:
                pause = random.uniform(lo, hi)
                out(f"   …waiting {pause:.0f}s before the next one")
                sleep(pause)
            try:
                transport.send(msg)  # type: ignore[union-attr]
            except Exception as exc:  # noqa: BLE001 — record any SMTP failure and move on
                store.update(c["id"], status="failed", error=str(exc)[:500])
                out(f"FAILED #{c['id']} {c['name']} <{email}>: {exc}")
                tally["failed"] += 1
                continue
            store.mark_sent(c["id"])
            sent_any = True
            out(f"sent → {c['name']} <{email}>")
            tally["sent"] += 1
    finally:
        if transport is not None:
            transport.close()
    if not live and tally["dry_run"]:
        out("\nDry run only — nothing was sent. Re-run with --live to send for real.")
    return tally
