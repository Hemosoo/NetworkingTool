# PennReach 🎓☕

A small command-line tool for Penn freshmen. It finds **incoming seniors at top firms**, gets their **Penn email**, and sends each one a short personal note asking to grab coffee or food. Every email goes through an **approve/decline** review queue, or you can switch on **full-auto mode**.

```
LinkedIn search ──bookmarklet──▶ contacts.csv ──import──▶ filter (incoming @ target firm, class of '27)
      ──find-emails (Penn Directory)──▶ draft ──review [a]pprove/[d]ecline/[e]dit──▶ send (rate-limited)
```

## Why it's built this way

| Decision | Why |
|---|---|
| **Local CLI + SQLite** instead of a web app or MCP server | It's a stop/start pipeline. State lives in `pennreach.db`, so you can import today, look up emails tomorrow and send next week, and no one is ever emailed twice. |
| **A bookmarklet captures LinkedIn results you're viewing** instead of a headless scraper | LinkedIn bans accounts that use automated logins and crawlers, and your account is your professional identity. The bookmarklet only reads the page already on your screen, at your own pace. |
| **Penn Directory lookup** instead of guessing emails | Penn addresses are PennKey-based (`jdoe@wharton.upenn.edu`, `smithj@seas.upenn.edu`…) and can't be derived from a name. A wrong guess emails a stranger. The tool walks you through each lookup and validates that what you paste is a `upenn.edu` address. |
| **Dry run by default, a daily cap, random delays** | 10–15 personal emails a day from your Penn account reads as a human. 200 in a minute gets flagged as spam and annoys the people you want to meet. |

## Setup

Requires Python 3.11+. There are no third-party dependencies.

```bash
git clone <this repo> && cd NetworkingTool
pip install -e .            # gives you the `pennreach` command (or use `python3 -m pennreach`)
pennreach init              # creates config.toml + pennreach.db
```

Edit `config.toml`:
- **`[me]`**: your name, school, major, year, interests, and Penn email.
- **`[targeting]`**: `grad_years` (current seniors, so `2027` for the 2026–27 year) and `target_firms`, plus `aliases` like `"GS" = "Goldman Sachs"`.
- **`[template]`**: the email. Placeholders: `{first_name}`, `{name}`, `{firm}`, `{role}`, `{role_clause}` (" as an Investment Banking Analyst" or empty), `{my_name}`, `{my_first_name}`, `{my_school}`, `{my_major}`, `{my_interests}`, `{my_year}`, `{my_year_short}`.
- **`[smtp]`**: how to send. Set the password in your shell, never in the file:
  ```bash
  export PENNREACH_SMTP_PASSWORD='your-app-password'
  ```
  For Gmail-based Penn accounts, use `smtp.gmail.com:587` with an [App Password](https://support.google.com/accounts/answer/185833). For Microsoft 365 accounts, use `smtp.office365.com:587`; SMTP AUTH has to be enabled for your account.

## Workflow

### 1. Find people on LinkedIn
Build the bookmarklet once:
```bash
python3 bookmarklet/build.py
```
Create a new browser bookmark and paste the printed `javascript:…` line as its URL.

Then search LinkedIn People with something like `incoming analyst`, filtered to **School: University of Pennsylvania**. Click the bookmark on each results page; it keeps a running list. On the last page, click **OK** to download `contacts.csv`.

You can also make the CSV by hand (columns `name,headline,linkedin_url`, plus optional `email,firm,role,class_year`), or add one person at a time:
```bash
pennreach add --name "Jordan Lee" --headline "Incoming IB Analyst @ Goldman Sachs | W'27"
```

### 2. Import and filter
```bash
pennreach import ~/Downloads/contacts.csv -v
```
Only people who are **incoming/returning at a target firm** and in your **target class year** are kept. `-v` shows why each of the others was filtered out.

### 3. Get their Penn emails
```bash
pennreach find-emails --open
```
For each person, look them up in the [Penn Directory](https://directory.apps.upenn.edu/directory/jsp/fast.do) and paste the email. You can also paste the whole directory row and the address is extracted.

### 4. Draft → review → send
```bash
pennreach draft
pennreach review
pennreach send
pennreach send --live
```
`review` gives you **[a]pprove / [d]ecline / [e]dit / [s]kip / [q]uit** for each draft, and `e` opens the email in `$EDITOR`. Plain `send` is a dry run that shows what would go out; `--live` actually sends.

### Full-auto mode
Set `auto = true` under `[mode]` in `config.toml`, then:
```bash
pennreach auto --live
```
This drafts, approves and sends everything that has an email. The daily cap, the delays, the never-email-twice rule and the opt-out list all still apply. Run it once a day, for example from cron, to work through the list at a steady pace.

### Housekeeping
```bash
pennreach status
pennreach list --status sent
pennreach optout someone@upenn.edu
```
`status` shows counts plus how many emails you can still send today. `optout` makes sure an address is never emailed again; use it if someone asks you to stop.

## Etiquette & policy (read this)

- **Keep it personal and low-volume.** Fifteen thoughtful emails get more coffee chats than 150 generic ones. Edit the template so it sounds like you.
- **Follow Penn's rules.** Penn's [Policy on Acceptable Use of Electronic Resources](https://isc.upenn.edu/policies) and the Directory's terms forbid bulk harvesting and mass mailing. Look people up one at a time, only for people you actually plan to contact.
- **Follow LinkedIn's terms.** The bookmarklet only reads pages you've opened yourself. Don't hook it up to anything that pages through results automatically.
- **Respect no.** If someone doesn't reply or asks you to stop, run `pennreach optout`.

## Development

```bash
python3 -m unittest discover -s tests -t . -v
```

```
pennreach/
  cli.py        # argparse subcommands
  importer.py   # CSV → contacts, targeting filters
  parsing.py    # headline parsing: incoming?, firm, role, class year
  finder.py     # Penn Directory–assisted email lookup + validation
  drafting.py   # template rendering
  review.py     # interactive approve/decline/edit queue
  sender.py     # SMTP, daily cap, delays, dedupe/opt-out guards
  db.py         # SQLite store + status machine
bookmarklet/    # LinkedIn capture bookmarklet + builder
```
