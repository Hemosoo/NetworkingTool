import tempfile
import unittest
import urllib.parse
from pathlib import Path

from pennreach.compose import compose_url, open_approved
from pennreach.db import Store

from .helpers import cfg


def scripted(answers):
    it = iter(answers)
    return lambda _prompt: next(it)


class ComposeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "t.db")
        self.cfg = cfg()

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _approved(self, name, email):
        cid = self.store.add_contact(name=name, firm="Jane Street", email=email)
        self.store.update(cid, subject="Coffee & chat?", body="Hi Taylor,\n\nLine 2 — thanks!\n",
                          status="approved")
        return cid

    def test_urls_encode_everything(self):
        body = "Hi Taylor,\n\nCoffee & a chat? 100% my treat — thanks!\n"
        g = compose_url("gmail", "tb@sas.upenn.edu", "Coffee & chat?", body, "me@sas.upenn.edu")
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(g).query)
        self.assertEqual(q["to"], ["tb@sas.upenn.edu"])
        self.assertEqual(q["su"], ["Coffee & chat?"])
        self.assertEqual(q["body"], [body])
        self.assertEqual(q["authuser"], ["me@sas.upenn.edu"])
        o = compose_url("outlook", "tb@sas.upenn.edu", "S", body)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(o).query)["body"], [body])
        m = compose_url("mailto", "tb@sas.upenn.edu", "S", body)
        self.assertTrue(m.startswith("mailto:tb%40sas.upenn.edu?subject=S&body="))
        self.assertNotIn("\n", m)
        self.assertNotIn("+", m)  # spaces must be %20 for mail apps

    def test_only_marked_sent_after_confirmation(self):
        a = self._approved("Ann One", "ann@upenn.edu")
        b = self._approved("Bob Two", "bob@upenn.edu")
        c = self._approved("Cat Three", "cat@upenn.edu")
        opened = []
        t = open_approved(self.store, self.cfg, via="gmail", ask=scripted(["x", "r", "y", "s", "d"]),
                          out=lambda _: None, opener=opened.append)
        self.assertEqual(t, {"sent": 1, "skipped": 1, "declined": 1})
        self.assertEqual(len(opened), 4)  # a twice (reopen), b, c
        self.assertEqual([self.store.get(i)["status"] for i in (a, b, c)],
                         ["sent", "approved", "declined"])

    def test_respects_daily_cap_and_asks_for_app(self):
        ids = [self._approved(f"P{i} Person", f"p{i}@upenn.edu") for i in range(3)]
        opened = []
        t = open_approved(self.store, self.cfg, ask=scripted(["o", "y", "y"]), out=lambda _: None,
                          opener=opened.append)
        self.assertEqual(t["sent"], 2)  # cap is 2/day in test config
        self.assertTrue(all(u.startswith("https://outlook.office.com/") for u in opened))
        self.assertEqual(self.store.get(ids[2])["status"], "approved")


if __name__ == "__main__":
    unittest.main()
