"""pennreach command-line interface."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from .config import load_config
from .db import STATUSES, Store
from .drafting import draft_for
from .finder import (
    PENN_DIRECTORY_URL,
    extract_penn_email,
    find_emails,
    import_directory_results,
    is_penn_email,
    lookup_list,
)
from .importer import evaluate, import_csv, passes_filters
from .review import review
from .sender import remaining_today, send_approved

ROOT = Path(__file__).resolve().parent.parent


def _store(args) -> Store:
    return Store(args.db)


def cmd_init(args) -> int:
    cfg_path = Path(args.config)
    if cfg_path.exists():
        print(f"{cfg_path} already exists — leaving it alone.")
    else:
        shutil.copy(ROOT / "config.example.toml", cfg_path)
        print(f"Created {cfg_path}. Fill in [me] and [smtp], then import some contacts.")
    _store(args).close()
    print(f"Database ready at {args.db}.")
    return 0


def cmd_import(args) -> int:
    cfg = load_config(args.config)
    store = _store(args)
    res = import_csv(args.csv, store, cfg, apply_filters=not args.no_filter)
    print(f"Added {res.added}, skipped {res.duplicates} duplicate(s), filtered {len(res.filtered)}.")
    if res.rows and res.no_headline * 2 > res.rows:
        print(f"\nWarning: {res.no_headline} of {res.rows} rows have no headline, so firm/role/class "
              "can't be detected and they get filtered out.\nRe-capture with the latest "
              "bookmarklet (`python3 bookmarklet/build.py`), or import with --no-filter.")
    if res.filtered and args.verbose:
        for name, reason in res.filtered:
            print(f"  - {name}: {reason}")
    elif res.filtered:
        print("  (use -v to see why each was filtered)")
    return 0


def cmd_add(args) -> int:
    cfg = load_config(args.config)
    row = {
        "name": args.name, "headline": args.headline or "", "linkedin_url": args.linkedin or "",
        "email": args.email or "", "firm": args.firm or "", "role": args.role or "",
    }
    fields, reason = evaluate(row, cfg)
    if fields is None:
        print(f"Not added: {reason}")
        return 1
    if args.email and not extract_penn_email(args.email):
        print("Email must be a @upenn.edu address.")
        return 1
    if not args.force and (reason := passes_filters(fields, cfg)):
        print(f"Not added: {reason} (use --force to add anyway)")
        return 1
    new_id = _store(args).add_contact(**fields)
    print(f"Added #{new_id}." if new_id else "Already in the list.")
    return 0


def cmd_find(args) -> int:
    n = find_emails(_store(args), open_browser=args.open)
    print(f"\nFilled in {n} email(s).")
    return 0


def cmd_lookup_list(args) -> int:
    import subprocess

    data = lookup_list(_store(args))
    n = data.count("],[") + 1 if data != "[]" else 0
    if not n:
        print("No contacts are waiting for an email.")
        return 0
    copied = False
    for cmd in (["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"]):
        try:
            subprocess.run(cmd, input=data.encode(), check=True, capture_output=True)
            copied = True
            break
        except (OSError, subprocess.CalledProcessError):
            continue
    if copied:
        print(f"Copied {n} name(s) to your clipboard.")
    else:
        print(f"Copy this line ({n} names):\n\n{data}\n")
    print(f"""
Next:
  1. Open {PENN_DIRECTORY_URL} and click "Log in" (PennKey) so emails are visible.
  2. Click your "PennReach: Penn Directory lookup" bookmark and paste the list.
  3. When it finishes: python3 -m pennreach import-emails ~/Downloads/penn_emails.csv""")
    return 0


def cmd_import_emails(args) -> int:
    t = import_directory_results(_store(args), args.csv)
    print(f"\nFilled {t['filled']} email(s) ({t['chosen']} picked by you), "
          f"{t['no_match']} with no match, {t['skipped']} skipped.")
    if t["filled"]:
        print("Next: `python3 -m pennreach draft`.")
    return 0


def cmd_draft(args) -> int:
    cfg = load_config(args.config)
    store = _store(args)
    statuses = ["ready", "drafted"] if args.redraft else ["ready"]
    n = 0
    for c in store.list(statuses):
        subject, body = draft_for(c, cfg)
        store.update(c["id"], subject=subject, body=body, status="drafted")
        n += 1
    print(f"Drafted {n} email(s). Next: `pennreach review`.")
    return 0


def cmd_review(args) -> int:
    t = review(_store(args))
    print(f"\nApproved {t['approved']}, declined {t['declined']}, skipped {t['skipped']}.")
    if t["approved"]:
        print("Next: `pennreach send` (dry run) then `pennreach send --live`.")
    return 0


def cmd_send(args) -> int:
    cfg = load_config(args.config)
    t = send_approved(_store(args), cfg, live=args.live, limit=args.limit)
    print(f"\nSent {t['sent']}, failed {t['failed']}, skipped {t['skipped']}.")
    return 1 if t["failed"] else 0


def cmd_auto(args) -> int:
    cfg = load_config(args.config)
    if not cfg["mode"]["auto"]:
        print("Full-auto mode is off. Set `auto = true` under [mode] in config.toml to enable it.")
        return 1
    store = _store(args)
    drafted = approved = 0
    for c in store.list(["ready"]):
        subject, body = draft_for(c, cfg)
        store.update(c["id"], subject=subject, body=body, status="drafted")
        drafted += 1
    for c in store.list(["drafted"]):
        store.update(c["id"], status="approved")
        approved += 1
    print(f"Auto: drafted {drafted}, auto-approved {approved}.")
    t = send_approved(store, cfg, live=args.live, limit=args.limit)
    print(f"\nSent {t['sent']}, failed {t['failed']}, skipped {t['skipped']}.")
    return 1 if t["failed"] else 0


def cmd_status(args) -> int:
    store = _store(args)
    counts = store.counts()
    width = max(map(len, STATUSES))
    for s in STATUSES:
        print(f"  {s:<{width}}  {counts[s]}")
    try:
        cfg = load_config(args.config)
        print(f"\nCan still send {remaining_today(store, cfg)} today "
              f"(cap {cfg['limits']['max_per_day']}/24h).")
    except FileNotFoundError:
        pass
    return 0


def cmd_list(args) -> int:
    rows = _store(args).list([args.status] if args.status else None)
    for c in rows:
        email = c["email"] or "—"
        print(f"#{c['id']:<4} {c['status']:<14} {c['name']:<26} {c['firm']:<22} "
              f"{c['class_year'] or '':<5} {email}")
    if not rows:
        print("(no contacts)")
    return 0


def cmd_optout(args) -> int:
    if not is_penn_email(args.email):
        print("Expected a @upenn.edu address.")
        return 1
    n = _store(args).optout(args.email)
    print(f"Marked {n} contact(s) do-not-contact." if n else "No contact with that email.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pennreach",
        description="Find incoming Penn seniors at top firms and ask them to grab coffee.",
    )
    p.add_argument("--config", default="config.toml", help="config file (default: config.toml)")
    p.add_argument("--db", default="pennreach.db", help="database file (default: pennreach.db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create config.toml and the database").set_defaults(func=cmd_init)

    s = sub.add_parser("import", help="import contacts from a CSV (e.g. bookmarklet export)")
    s.add_argument("csv")
    s.add_argument("--no-filter", action="store_true", help="import everyone, skip targeting filters")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(func=cmd_import)

    s = sub.add_parser("add", help="add one contact by hand")
    s.add_argument("--name", required=True)
    s.add_argument("--headline")
    s.add_argument("--firm")
    s.add_argument("--role")
    s.add_argument("--email")
    s.add_argument("--linkedin")
    s.add_argument("--force", action="store_true", help="add even if it fails targeting filters")
    s.set_defaults(func=cmd_add)

    s = sub.add_parser("find-emails", help="look up Penn emails via the Penn Directory")
    s.add_argument("--open", action="store_true", help="open the Penn Directory in your browser")
    s.set_defaults(func=cmd_find)

    sub.add_parser(
        "lookup-list", help="copy pending names for the Penn Directory bookmarklet"
    ).set_defaults(func=cmd_lookup_list)

    s = sub.add_parser("import-emails", help="read penn_emails.csv from the directory bookmarklet")
    s.add_argument("csv")
    s.set_defaults(func=cmd_import_emails)

    s = sub.add_parser("draft", help="write emails for contacts that have an address")
    s.add_argument("--redraft", action="store_true", help="also re-render existing drafts")
    s.set_defaults(func=cmd_draft)

    sub.add_parser("review", help="approve / decline / edit drafts one by one").set_defaults(
        func=cmd_review
    )

    for name, func, help_ in (
        ("send", cmd_send, "send approved emails (dry run unless --live)"),
        ("auto", cmd_auto, "full-auto: draft + approve + send everything ready"),
    ):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--live", action="store_true", help="actually send (default is a dry run)")
        s.add_argument("--limit", type=int, help="send at most N this run")
        s.set_defaults(func=func)

    sub.add_parser("status", help="counts by status + remaining daily budget").set_defaults(
        func=cmd_status
    )

    s = sub.add_parser("list", help="list contacts")
    s.add_argument("--status", choices=STATUSES)
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("optout", help="never email this address again")
    s.add_argument("email")
    s.set_defaults(func=cmd_optout)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (FileNotFoundError, ValueError, KeyError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nInterrupted — progress so far is saved.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
