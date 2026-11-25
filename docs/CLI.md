# PennReach command-line version (advanced)

Everything the Chrome extension does, as a Python CLI with SQLite storage. Most people should use the [extension](../README.md) instead; this version suits people comfortable in a terminal, and it can send automatically over SMTP.

## Setup

Requires **Python 3.11+**. Check with `python3 --version`. The built-in Python on macOS is 3.9 and is too old; run `brew install python@3.12` and use `python3.12`. There are no third-party dependencies, so nothing needs installing.

```bash
git clone <this repo> && cd <repo folder>
python3 -m pennreach init   # creates config.toml + pennreach.db
```

Run every command from the repo folder as `python3 -m pennreach <command>`. The examples below write `pennreach` for short. If you'd rather type just `pennreach`, install it into a virtual environment:

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -e .
```

After that, run `source .venv/bin/activate` in each new terminal before using `pennreach`.

Edit `config.toml`:
- **`[me]`**: your name, school, major, year, interests, and Penn email.
- **`[targeting]`**: `grad_years` (current seniors, so `2027` for the 2026–27 year) and `target_firms`, plus `aliases` like `"GS" = "Goldman Sachs"`.
- **`[template]`**: the email. Placeholders: `{first_name}`, `{name}`, `{firm}`, `{role}`, `{role_clause}` (" as an Investment Banking Analyst" or empty), `{my_name}`, `{my_first_name}`, `{my_school}`, `{my_major}`, `{my_interests}`, `{my_year}`, `{my_year_short}`.
- **`[send]`**: `via` sets which mail app `pennreach open` uses.
- **`[smtp]`**: only needed for automatic sending (`send --live`). Set the password in your shell, never in the file:
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

Then search LinkedIn People with something like `incoming analyst`, filtered to **School: University of Pennsylvania**. Click the bookmark on each results page; it keeps a running list. Each click asks what to do next: press **Cancel** to keep browsing, type **d** to download `contacts.csv`, or type **c** to clear the list and start over. People with no headline are left out of the download.

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

**Automatic (recommended).** Student emails in the Penn Directory are only visible when you're logged in, so the lookup runs in your own browser:

1. One-time setup: run `python3 bookmarklet/build.py directory` and save the printed line as a bookmark named "PennReach: Penn Directory lookup".
2. Copy your pending names to the clipboard:
   ```bash
   pennreach lookup-list
   ```
3. Open the [Penn Directory](https://directory.apps.upenn.edu/directory/jsp/fast.do), click **Log in** and sign in with PennKey and Duo.
4. Click the bookmark and paste the list. It searches each person with a short pause between searches, then downloads `penn_emails.csv`.
5. Import the results:
   ```bash
   pennreach import-emails ~/Downloads/penn_emails.csv
   ```
   A single match is filled in automatically. When there are several (two "Jordan Lee"s, or "Chris" listed as "Christopher"), you pick one from a numbered list.

**Manual fallback,** for anyone the lookup couldn't find:
```bash
pennreach find-emails --open
```
This walks you through each person. Paste the email, or the whole directory row, and the address is extracted.

### 4. Draft → review → send
```bash
pennreach draft
pennreach review
pennreach open
```
`review` gives you **[a]pprove / [d]ecline / [e]dit / [s]kip / [q]uit** for each draft, and `e` opens the email in `$EDITOR`. Approving never sends anything.

**`pennreach open` (recommended)** opens each approved email already filled in, in Gmail, in Outlook on the web, or in your Mac's Mail app. You read it, click Send yourself, then press `y` in the terminal so it's recorded as sent. No passwords or setup needed. Set `via = "gmail"` (or `"outlook"` / `"mailto"`) under `[send]` in `config.toml` to skip the question each time.

**Automatic sending (optional):** `pennreach send` shows a dry run of who would be emailed. `pennreach send --live` sends over SMTP, which needs the `[smtp]` settings and an app password. Many PennKey/Duo accounts don't allow app passwords, in which case use `open`.

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
  compose.py    # `open`: pre-filled compose windows, you click Send
  sender.py     # SMTP, daily cap, delays, dedupe/opt-out guards
  db.py         # SQLite store + status machine
bookmarklet/    # LinkedIn capture + Penn Directory lookup bookmarklets, builder
```
