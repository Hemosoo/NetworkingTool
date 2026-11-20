"""Render personalized emails from the config template."""

from __future__ import annotations

import string
from typing import Any, Mapping

from .parsing import clean_name, first_name


def _article(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


def template_fields(contact: Mapping[str, Any], me: Mapping[str, Any]) -> dict[str, str]:
    name = clean_name(contact["name"])
    role = (contact["role"] or "").strip()
    year = me.get("year")
    return {
        "name": name,
        "first_name": first_name(name),
        "last_name": name.split()[-1] if name else "",
        "firm": contact["firm"] or "your firm",
        "role": role,
        "role_clause": f" as {_article(role)} {role}" if role else "",
        "my_name": me.get("name", ""),
        "my_first_name": first_name(me.get("name", "")),
        "my_school": me.get("school", ""),
        "my_major": me.get("major", ""),
        "my_interests": me.get("interests", ""),
        "my_year": str(year or ""),
        "my_year_short": str(year)[-2:] if year else "",
        "my_email": me.get("penn_email", ""),
    }


def render(template: str, fields: Mapping[str, str]) -> str:
    missing = [
        name for _, name, _, _ in string.Formatter().parse(template)
        if name and name not in fields
    ]
    if missing:
        raise KeyError(
            f"Template uses unknown placeholder(s): {', '.join(sorted(set(missing)))}. "
            f"Available: {', '.join(sorted(fields))}"
        )
    return template.format_map(fields)


def draft_for(contact: Mapping[str, Any], cfg: Mapping[str, Any]) -> tuple[str, str]:
    fields = template_fields(contact, cfg["me"])
    return render(cfg["template"]["subject"], fields), render(cfg["template"]["body"], fields)
