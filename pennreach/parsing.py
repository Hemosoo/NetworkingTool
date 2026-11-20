"""Parse LinkedIn headlines: is this an incoming hire, at which target firm, in what role, which class?"""

from __future__ import annotations

import re
from dataclasses import dataclass

# "Incoming IB Analyst @ Goldman Sachs", "Returning SWE at Jane Street", "Future Associate | McKinsey"
INCOMING_RE = re.compile(r"\b(incoming|returning|future|joining)\b", re.I)
ROLE_RE = re.compile(
    r"\b(?:incoming|returning|future)\s+(?P<role>[^@|·•,;]+?)\s*(?:@|\bat\b|\||·|•|,)\s*(?P<rest>.*)",
    re.I,
)
# Class years: "'27", "’27", "C'27", "W27", "2027", "Class of 2027"
YEAR_PATTERNS = (
    re.compile(r"(?<![\w\d])(?:[CWEN]\s?)?['’‘](\d{2})(?!\d)", re.I),
    re.compile(r"(?<![\w\d])[CWEN](\d{2})(?!\d)"),
    re.compile(r"(?<!\d)20(\d{2})(?!\d)"),
)


@dataclass
class Parsed:
    is_incoming: bool
    firm: str
    role: str
    class_year: int | None


def _firm_pattern(name: str) -> re.Pattern:
    return re.compile(r"(?<![\w])" + re.escape(name) + r"(?![\w])", re.I)


def match_firm(text: str, firms: list[str], aliases: dict[str, str] | None = None) -> str:
    """Return the canonical target firm mentioned in text ('' if none).

    Longer names win, so "Citadel Securities" beats "Citadel" and "Bain Capital" beats "Bain".
    """
    candidates: list[tuple[str, str]] = [(f, f) for f in firms]
    candidates += [(alias, canon) for alias, canon in (aliases or {}).items()]
    candidates.sort(key=lambda pair: len(pair[0]), reverse=True)
    for needle, canon in candidates:
        # Short all-caps aliases (GS, SIG, IMC, HRT) must match case-sensitively.
        if needle.isupper() and len(needle) <= 4:
            if re.search(r"(?<![\w])" + re.escape(needle) + r"(?![\w])", text):
                return canon
        elif _firm_pattern(needle).search(text):
            return canon
    return ""


def parse_class_year(text: str) -> int | None:
    for pattern in YEAR_PATTERNS:
        for m in pattern.finditer(text):
            yy = int(m.group(1))
            if 20 <= yy <= 40:  # plausible undergrad class years 2020–2040
                return 2000 + yy
    return None


def parse_headline(
    headline: str, firms: list[str], aliases: dict[str, str] | None = None
) -> Parsed:
    headline = " ".join((headline or "").split())
    is_incoming = bool(INCOMING_RE.search(headline))
    role = ""
    firm = ""
    m = ROLE_RE.search(headline)
    if m:
        role = m.group("role").strip(" -–—")
        # Prefer the firm named right after the "Incoming X @" clause.
        firm = match_firm(m.group("rest"), firms, aliases)
    if not firm:
        firm = match_firm(headline, firms, aliases)
    return Parsed(
        is_incoming=is_incoming,
        firm=firm,
        role=role,
        class_year=parse_class_year(headline),
    )


def clean_name(raw: str) -> str:
    """'Jane Q. Doe, CFA (she/her) 🚀' -> 'Jane Q. Doe'."""
    name = re.sub(r"\(.*?\)", "", raw or "")
    name = name.split(",")[0]
    name = re.sub(r"[^\w\s.'’-]", "", name)
    return " ".join(name.split())


def first_name(name: str) -> str:
    parts = clean_name(name).split()
    return parts[0] if parts else ""
