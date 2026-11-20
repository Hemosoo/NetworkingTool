import copy

from pennreach.config import DEFAULTS, _merge

CFG = _merge(DEFAULTS, {
    "me": {"name": "Alex Chen", "school": "the College", "major": "Economics", "year": 2030,
           "interests": "finance", "penn_email": "alexchen@sas.upenn.edu"},
    "targeting": {
        "grad_years": [2027],
        "require_incoming": True,
        "target_firms": ["Goldman Sachs", "Jane Street", "McKinsey", "Evercore",
                         "Citadel", "Citadel Securities", "Bain Capital", "Bain & Company"],
        "aliases": {"GS": "Goldman Sachs", "Bain": "Bain & Company"},
    },
    "limits": {"max_per_day": 2, "min_delay_seconds": 1, "max_delay_seconds": 2},
    "template": {
        "subject": "Coffee, {first_name}?",
        "body": "Hi {first_name}, congrats on {firm}{role_clause}! — {my_first_name} '{my_year_short}\n",
    },
})


def cfg(**overrides):
    return _merge(copy.deepcopy(CFG), overrides)
