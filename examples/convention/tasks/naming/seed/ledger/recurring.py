"""Recurring ledger entries."""

ENTRIES = [
    {"id": 3, "date": "2026-07-02", "label": "rent", "amount": 42000},
    {"id": 1, "date": "2026-07-02", "label": "rent", "amount": 18000},
    {"id": 2, "date": "2026-07-01", "label": "utilities", "amount": 2400},
    {"id": 4, "date": "2026-07-05", "label": "rent", "amount": 9000},
]


def all_entries():
    return list(ENTRIES)
