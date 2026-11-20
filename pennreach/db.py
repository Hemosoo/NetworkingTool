"""SQLite store for contacts and their outreach status.

Status flow:
    new ──(email found)──> ready ──(draft)──> drafted ──> approved ──> sent
                                                  └──> declined        └──> failed
    any ──(optout)──> do_not_contact
"""

from __future__ import annotations

import datetime as dt
import sqlite3
from pathlib import Path
from typing import Any, Iterable

STATUSES = (
    "new",
    "ready",
    "drafted",
    "approved",
    "declined",
    "sent",
    "failed",
    "do_not_contact",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS contacts (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    headline      TEXT NOT NULL DEFAULT '',
    linkedin_url  TEXT UNIQUE,
    firm          TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT '',
    class_year    INTEGER,
    email         TEXT,
    email_source  TEXT,
    status        TEXT NOT NULL DEFAULT 'new',
    subject       TEXT,
    body          TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
"""

UPDATABLE = {
    "name", "headline", "linkedin_url", "firm", "role", "class_year", "email",
    "email_source", "status", "subject", "body", "error", "sent_at",
}


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def normalize_linkedin_url(url: str | None) -> str | None:
    if not url:
        return None
    url = url.strip().split("?")[0].split("#")[0].rstrip("/")
    if url.startswith("/in/"):
        url = "https://www.linkedin.com" + url
    url = url.replace("http://", "https://")
    url = url.replace("https://linkedin.com", "https://www.linkedin.com")
    return url.lower() or None


class Store:
    def __init__(self, path: str | Path):
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ---- writes -------------------------------------------------------
    def add_contact(self, **fields: Any) -> int | None:
        """Insert a contact. Returns the new id, or None if it's a duplicate."""
        fields["linkedin_url"] = normalize_linkedin_url(fields.get("linkedin_url"))
        if self._find_duplicate(fields) is not None:
            return None
        email = fields.get("email")
        fields.setdefault("status", "ready" if email else "new")
        ts = _iso(now())
        fields["created_at"] = fields["updated_at"] = ts
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        cur = self.conn.execute(
            f"INSERT INTO contacts ({cols}) VALUES ({marks})", tuple(fields.values())
        )
        self.conn.commit()
        return cur.lastrowid

    def _find_duplicate(self, fields: dict[str, Any]) -> int | None:
        if fields.get("linkedin_url"):
            row = self.conn.execute(
                "SELECT id FROM contacts WHERE linkedin_url = ?", (fields["linkedin_url"],)
            ).fetchone()
            if row:
                return row["id"]
        if fields.get("email"):
            row = self.conn.execute(
                "SELECT id FROM contacts WHERE lower(email) = lower(?)", (fields["email"],)
            ).fetchone()
            if row:
                return row["id"]
        row = self.conn.execute(
            "SELECT id FROM contacts WHERE lower(name) = lower(?) AND lower(firm) = lower(?)",
            (fields.get("name", ""), fields.get("firm", "")),
        ).fetchone()
        return row["id"] if row else None

    def update(self, contact_id: int, **fields: Any) -> None:
        bad = set(fields) - UPDATABLE
        if bad:
            raise ValueError(f"Cannot update fields: {bad}")
        if "status" in fields and fields["status"] not in STATUSES:
            raise ValueError(f"Unknown status {fields['status']!r}")
        fields["updated_at"] = _iso(now())
        sets = ", ".join(f"{k} = ?" for k in fields)
        self.conn.execute(
            f"UPDATE contacts SET {sets} WHERE id = ?", (*fields.values(), contact_id)
        )
        self.conn.commit()

    def mark_sent(self, contact_id: int, when: dt.datetime | None = None) -> None:
        self.update(contact_id, status="sent", sent_at=_iso(when or now()), error=None)

    def optout(self, email: str) -> int:
        cur = self.conn.execute(
            "UPDATE contacts SET status = 'do_not_contact', updated_at = ? "
            "WHERE lower(email) = lower(?)",
            (_iso(now()), email.strip()),
        )
        self.conn.commit()
        return cur.rowcount

    # ---- reads --------------------------------------------------------
    def get(self, contact_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM contacts WHERE id = ?", (contact_id,)
        ).fetchone()

    def list(self, statuses: Iterable[str] | None = None) -> list[sqlite3.Row]:
        if statuses:
            statuses = list(statuses)
            marks = ", ".join("?" for _ in statuses)
            return self.conn.execute(
                f"SELECT * FROM contacts WHERE status IN ({marks}) ORDER BY id", statuses
            ).fetchall()
        return self.conn.execute("SELECT * FROM contacts ORDER BY id").fetchall()

    def counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT status, COUNT(*) AS n FROM contacts GROUP BY status"
        ).fetchall()
        out = {s: 0 for s in STATUSES}
        out.update({r["status"]: r["n"] for r in rows})
        return out

    def sent_since(self, since: dt.datetime) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM contacts WHERE sent_at IS NOT NULL AND sent_at >= ?",
            (_iso(since),),
        ).fetchone()
        return row["n"]

    def email_blocked(self, email: str, exclude_id: int | None = None) -> str | None:
        """Reason this address must not be emailed (already contacted / opted out), else None."""
        row = self.conn.execute(
            "SELECT status FROM contacts WHERE lower(email) = lower(?) AND id != ? "
            "AND status IN ('sent', 'do_not_contact') LIMIT 1",
            (email, exclude_id or -1),
        ).fetchone()
        if row:
            return "already emailed" if row["status"] == "sent" else "opted out"
        return None
