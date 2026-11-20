import unittest

from pennreach.parsing import clean_name, first_name, match_firm, parse_class_year, parse_headline

FIRMS = ["Goldman Sachs", "Citadel", "Citadel Securities", "Bain Capital", "Bain & Company", "SIG"]
ALIASES = {"GS": "Goldman Sachs", "Bain": "Bain & Company"}


class ParsingTests(unittest.TestCase):
    def test_incoming_role_and_firm(self):
        p = parse_headline("Incoming IB Analyst @ Goldman Sachs | Wharton '27", FIRMS, ALIASES)
        self.assertTrue(p.is_incoming)
        self.assertEqual(p.firm, "Goldman Sachs")
        self.assertEqual(p.role, "IB Analyst")
        self.assertEqual(p.class_year, 2027)

    def test_returning_at(self):
        p = parse_headline("Returning Trader at Citadel Securities", FIRMS, ALIASES)
        self.assertEqual((p.firm, p.role), ("Citadel Securities", "Trader"))

    def test_longest_firm_wins(self):
        self.assertEqual(match_firm("Bain Capital PE", FIRMS, ALIASES), "Bain Capital")
        self.assertEqual(match_firm("Associate Consultant, Bain", FIRMS, ALIASES), "Bain & Company")

    def test_short_aliases_are_case_sensitive(self):
        self.assertEqual(match_firm("Incoming @ GS", FIRMS, ALIASES), "Goldman Sachs")
        self.assertEqual(match_firm("gs is great", FIRMS, ALIASES), "")
        self.assertEqual(match_firm("designer", FIRMS, ALIASES), "")  # 'SIG' inside a word

    def test_not_incoming(self):
        p = parse_headline("Student at the University of Pennsylvania", FIRMS, ALIASES)
        self.assertFalse(p.is_incoming)
        self.assertEqual(p.firm, "")

    def test_class_years(self):
        for text, year in [("Penn C'27", 2027), ("W27", 2027), ("Class of 2028", 2028),
                           ("Penn ’26", 2026), ("Wharton '27 | ex-GS", 2027)]:
            self.assertEqual(parse_class_year(text), year, text)
        self.assertIsNone(parse_class_year("24/7 hustle"))

    def test_names(self):
        self.assertEqual(clean_name("Priya Patel (she/her) 🚀"), "Priya Patel")
        self.assertEqual(clean_name("Jane Doe, CFA"), "Jane Doe")
        self.assertEqual(first_name("Mary-Kate O'Neil"), "Mary-Kate")


if __name__ == "__main__":
    unittest.main()
