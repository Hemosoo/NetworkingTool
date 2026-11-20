"""Import people from a CSV (e.g. the LinkedIn capture bookmarklet output) and filter to targets."""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .db import Store
from .finder import extract_penn_email
from .parsing import clean_name, match_firm, parse_class_year, parse_headline

# Accept a few common header spellings.
COLUMN_ALIASES = {
    "name": ("name", "full_name", "full name"),
    "headline": ("headline", "title", "occupation"),
    "linkedin_url": ("linkedin_url", "linkedin", "url", "profile", "profile_url"),
    "email": ("email", "penn_email", "e-mail"),
    "firm": ("firm", "company"),
    "role": ("role", "position"),
    "class_year": ("class_year", "year", "grad_year"),
    "education": ("education", "school"),
}


@dataclass
class ImportResult:
    added: int = 0
    duplicates: int = 0
    filtered: list[tuple[str, str]] = field(default_factory=list)  # (name, reason)


def _pick(row: Mapping[str, str], key: str) -> str:
    lowered = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
    for alias in COLUMN_ALIASES[key]:
        if lowered.get(alias):
            return lowered[alias]
    return ""


def evaluate(row: Mapping[str, str], cfg: Mapping[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """Turn a CSV row into contact fields, or (None, reason) if it doesn't match targeting."""
    t = cfg["targeting"]
    name = clean_name(_pick(row, "name"))
    if not name:
        return None, "missing name"
    headline = _pick(row, "headline")
    parsed = parse_headline(headline, t["target_firms"], t["aliases"])

    firm = parsed.firm
    explicit_firm = _pick(row, "firm")
    if explicit_firm:
        firm = match_firm(explicit_firm, t["target_firms"], t["aliases"]) or explicit_firm

    year_text = _pick(row, "class_year")
    class_year = (
        int(year_text) if year_text.isdigit() else parse_class_year(year_text)
    ) or parse_class_year(_pick(row, "education")) or parsed.class_year

    fields: dict[str, Any] = {
        "name": name,
        "headline": headline,
        "linkedin_url": _pick(row, "linkedin_url") or None,
        "firm": firm,
        "role": _pick(row, "role") or parsed.role,
        "class_year": class_year,
    }
    email = extract_penn_email(_pick(row, "email"))
    if email:
        fields["email"] = email
        fields["email_source"] = "csv"
    return fields, ""


def passes_filters(fields: Mapping[str, Any], cfg: Mapping[str, Any]) -> str:
    """'' if the contact matches targeting, otherwise the reason it was filtered out."""
    t = cfg["targeting"]
    if t["target_firms"] and fields["firm"] not in t["target_firms"]:
        return "not at a target firm"
    if t["require_incoming"] and not (
        fields["role"] or "incoming" in fields["headline"].lower()
        or "returning" in fields["headline"].lower()
        or "future" in fields["headline"].lower()
    ):
        return "headline doesn't say incoming/returning"
    years = t["grad_years"]
    if years and fields["class_year"] is not None and fields["class_year"] not in years:
        return f"class of {fields['class_year']}, not {'/'.join(map(str, years))}"
    return ""


def import_csv(
    path: str | Path, store: Store, cfg: Mapping[str, Any], *, apply_filters: bool = True
) -> ImportResult:
    result = ImportResult()
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            fields, reason = evaluate(row, cfg)
            if fields is None:
                result.filtered.append((_pick(row, "name") or "?", reason))
                continue
            if apply_filters:
                reason = passes_filters(fields, cfg)
                if reason:
                    result.filtered.append((fields["name"], reason))
                    continue
            if store.add_contact(**fields) is None:
                result.duplicates += 1
            else:
                result.added += 1
    return result
