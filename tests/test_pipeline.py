import datetime as dt
import tempfile
import unittest
from pathlib import Path

from pennreach.db import Store
from pennreach.drafting import draft_for
from pennreach.finder import (
    extract_penn_email,
    find_emails,
    import_directory_results,
    is_penn_email,
    lookup_list,
)
from pennreach.importer import import_csv
from pennreach.review import review
from pennreach.sender import send_approved

from .helpers import cfg

SAMPLE = Path(__file__).resolve().parent.parent / "examples" / "contacts.sample.csv"


class FakeTransport:
    def __init__(self, fail_for=()):
        self.sent, self.fail_for, self.closed = [], set(fail_for), False

    def send(self, msg):
        if msg["To"] in self.fail_for:
            raise OSError("550 mailbox unavailable")
        self.sent.append(msg)

    def close(self):
        self.closed = True


def scripted(answers):
    it = iter(answers)
    return lambda _prompt: next(it)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "t.db")
        self.cfg = cfg()

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _add_ready(self, name, email, firm="Goldman Sachs", role="Analyst"):
        cid = self.store.add_contact(name=name, firm=firm, role=role, email=email)
        subject, body = draft_for(self.store.get(cid), self.cfg)
        self.store.update(cid, subject=subject, body=body, status="approved")
        return cid

    def test_import_filters_to_incoming_seniors_at_target_firms(self):
        res = import_csv(SAMPLE, self.store, self.cfg)
        names = sorted(c["name"] for c in self.store.list())
        self.assertEqual(names, ["Jordan Lee", "Marcus Wright", "Priya Patel"])
        reasons = dict(res.filtered)
        self.assertIn("class of 2028", reasons["Emily Chen"])
        self.assertIn("target firm", reasons["Sam Rivera"])
        self.assertIn("target firm", reasons["Alex Kim"])
        # re-import is idempotent
        again = import_csv(SAMPLE, self.store, self.cfg)
        self.assertEqual((again.added, again.duplicates), (0, 3))

    def test_import_counts_rows_without_headlines(self):
        path = Path(self.tmp.name) / "names_only.csv"
        path.write_text("name,headline,location,linkedin_url\n"
                        "Casey Nguyen,,,https://www.linkedin.com/in/casey-nguyen-example\n")
        res = import_csv(path, self.store, self.cfg)
        self.assertEqual((res.rows, res.no_headline, res.added), (1, 1, 0))

    def test_real_world_headlines(self):
        c = cfg(targeting={"target_firms": ["J.P. Morgan", "SIG", "Jane Street"], "grad_years": [2027]})
        path = Path(self.tmp.name) / "real.csv"
        path.write_text(
            "name,headline\n"
            "Dana O,Econ @ Penn | Incoming @JPMorganChase\n"
            "Avery Z,Incoming Intern at Susquehanna International Group\n"
            "Riley P,Incoming SWE Intern @ Jane Street\n"
            "Drew H,CS @ Penn | Incoming @ Jane Street\n")
        res = import_csv(path, self.store, c)
        kept = {r["name"]: r["firm"] for r in self.store.list()}
        self.assertEqual(kept, {"Dana O": "J.P. Morgan", "Drew H": "Jane Street"})
        self.assertIn("internship", dict(res.filtered)["Avery Z"])

    def test_penn_email_validation(self):
        self.assertTrue(is_penn_email("jdoe@wharton.upenn.edu"))
        self.assertTrue(is_penn_email("jdoe@upenn.edu"))
        self.assertFalse(is_penn_email("jdoe@gmail.com"))
        self.assertFalse(is_penn_email("jdoe@upenn.edu.evil.com"))
        self.assertEqual(
            extract_penn_email("Doe, Jane  Student  JDoe@SEAS.upenn.edu  CIS"),
            "jdoe@seas.upenn.edu",
        )

    def test_find_emails_interactive(self):
        a = self.store.add_contact(name="Jordan Lee", firm="Goldman Sachs")
        b = self.store.add_contact(name="Priya Patel", firm="Jane Street")
        out = []
        n = find_emails(self.store, ask=scripted(["jordan@gmail.com", "jlee@wharton.upenn.edu", "s"]),
                        out=out.append)
        self.assertEqual(n, 1)
        self.assertEqual(self.store.get(a)["status"], "ready")
        self.assertEqual(self.store.get(a)["email"], "jlee@wharton.upenn.edu")
        self.assertEqual(self.store.get(b)["status"], "new")

    def test_directory_lookup_roundtrip(self):
        import json

        a = self.store.add_contact(name="Taylor Brooks", firm="Jane Street")
        b = self.store.add_contact(name="Jordan Lee", firm="Goldman Sachs")
        c = self.store.add_contact(name="Morgan Reyes", firm="Citadel")
        d = self.store.add_contact(name="Sam Nobody", firm="SIG")
        self.store.add_contact(name="Sam L.", firm="SIG")
        people = json.loads(lookup_list(self.store))
        self.assertEqual([p[1:] for p in people],
                         [["Taylor", "Brooks"], ["Jordan", "Lee"], ["Morgan", "Reyes"], ["Sam", "Nobody"]])
        path = Path(self.tmp.name) / "penn_emails.csv"
        path.write_text(
            "contact_id,contact_name,directory_name,affiliation,email\n"
            f'{a},Taylor Brooks,"Brooks, Taylor Ann",Student - College,tbrooks@sas.upenn.edu\n'
            f'{b},Jordan Lee,"Lee, Jordan A",Student - Wharton,jlee1@wharton.upenn.edu\n'
            f'{b},Jordan Lee,"Lee, Jordan B",Student - SEAS,jlee2@seas.upenn.edu\n'
            f'{c},Morgan Reyes,"Reyes, Morgan",Student - SEAS,\n'
            f"{d},Sam Nobody,,,\n")
        out = []
        t = import_directory_results(self.store, path, ask=scripted(["2"]), out=out.append)
        self.assertEqual((t["filled"], t["chosen"], t["no_match"]), (2, 1, 2))
        self.assertEqual(self.store.get(a)["email"], "tbrooks@sas.upenn.edu")
        self.assertEqual(self.store.get(b)["email"], "jlee2@seas.upenn.edu")
        self.assertEqual(self.store.get(c)["status"], "new")

    def test_directory_import_detects_not_logged_in(self):
        a = self.store.add_contact(name="Taylor Brooks", firm="Jane Street")
        path = Path(self.tmp.name) / "penn_emails.csv"
        path.write_text("contact_id,contact_name,directory_name,affiliation,email\n"
                        f'{a},Taylor Brooks,"Brooks, Taylor",Student,\n')
        out = []
        t = import_directory_results(self.store, path, out=out.append)
        self.assertEqual(t["filled"], 0)
        self.assertIn("weren't logged in", out[0])

    def test_draft_renders_personalized(self):
        cid = self.store.add_contact(name="Priya Patel (she/her)", firm="Jane Street",
                                     role="Software Engineer", email="ppatel@seas.upenn.edu")
        subject, body = draft_for(self.store.get(cid), self.cfg)
        self.assertEqual(subject, "Coffee, Priya?")
        self.assertIn("congrats on Jane Street as a Software Engineer!", body)
        self.assertIn("Alex '30", body)

    def test_unknown_placeholder_is_a_clear_error(self):
        cid = self.store.add_contact(name="X Y", firm="GS", email="xy@upenn.edu")
        bad = cfg(template={"subject": "Hi {nickname}", "body": "b"})
        with self.assertRaises(KeyError):
            draft_for(self.store.get(cid), bad)

    def test_review_accept_decline_edit(self):
        ids = [self.store.add_contact(name=n, firm="Goldman Sachs", email=f"{n[:3].lower()}@upenn.edu")
               for n in ("Ann One", "Bob Two", "Cat Three")]
        for cid in ids:
            s, b = draft_for(self.store.get(cid), self.cfg)
            self.store.update(cid, subject=s, body=b, status="drafted")
        tally = review(self.store, ask=scripted(["a", "d", "e", "a"]), out=lambda _: None,
                       editor=lambda s, b: ("Edited subject", b + "PS hi\n"))
        self.assertEqual(tally, {"approved": 2, "declined": 1, "skipped": 0})
        statuses = [self.store.get(i)["status"] for i in ids]
        self.assertEqual(statuses, ["approved", "declined", "approved"])
        self.assertEqual(self.store.get(ids[2])["subject"], "Edited subject")

    def test_dry_run_sends_nothing(self):
        cid = self._add_ready("Ann One", "ann@upenn.edu")
        transport = FakeTransport()
        t = send_approved(self.store, self.cfg, live=False, transport_factory=lambda: transport,
                          out=lambda _: None)
        self.assertEqual(t["dry_run"], 1)
        self.assertEqual(transport.sent, [])
        self.assertEqual(self.store.get(cid)["status"], "approved")

    def test_live_send_respects_daily_cap_and_records_failures(self):
        ids = [self._add_ready(f"P{i} Person", f"p{i}@upenn.edu") for i in range(4)]
        transport = FakeTransport(fail_for={"p0@upenn.edu"})
        sleeps = []
        t = send_approved(self.store, self.cfg, live=True, transport_factory=lambda: transport,
                          sleep=sleeps.append, out=lambda _: None)
        # cap is 2/day: p0 fails (doesn't count), p1 + p2 sent, p3 waits for tomorrow
        self.assertEqual((t["sent"], t["failed"]), (2, 1))
        self.assertEqual([self.store.get(i)["status"] for i in ids],
                         ["failed", "sent", "sent", "approved"])
        self.assertEqual(len(sleeps), 1)  # paused between the two successful sends
        self.assertTrue(transport.closed)
        self.assertEqual(transport.sent[0]["From"], "Alex Chen <alexchen@sas.upenn.edu>")
        # next run the same day: cap reached
        t2 = send_approved(self.store, self.cfg, live=True, transport_factory=FakeTransport,
                           out=lambda _: None)
        self.assertEqual(t2["sent"], 0)

    def test_cap_window_is_rolling_24h(self):
        old = self.store.add_contact(name="Old One", firm="GS", email="old@upenn.edu")
        self.store.mark_sent(old, when=dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=25))
        self._add_ready("New One", "new@upenn.edu")
        t = send_approved(self.store, self.cfg, live=True, transport_factory=FakeTransport,
                          sleep=lambda _: None, out=lambda _: None)
        self.assertEqual(t["sent"], 1)

    def test_never_email_twice_or_opted_out(self):
        first = self._add_ready("Ann One", "ann@upenn.edu")
        self.store.mark_sent(first, when=dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3))
        dup = self.store.add_contact(name="Ann One (alt)", firm="Jane Street", email="ANN@upenn.edu")
        self.assertIsNone(dup)  # deduped on email at insert
        # also guarded at send time if a row slipped through
        cid = self._add_ready("Bob Two", "bob@upenn.edu")
        self.store.optout("bob@upenn.edu")
        self.assertEqual(self.store.get(cid)["status"], "do_not_contact")
        t = send_approved(self.store, self.cfg, live=True, transport_factory=FakeTransport,
                          out=lambda _: None)
        self.assertEqual(t["sent"], 0)


if __name__ == "__main__":
    unittest.main()
