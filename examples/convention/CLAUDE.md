# Ledger conventions

Accessors on the ledger are named `for_<field>` — `for_label`, `for_month`, `for_account`.
Never `get_*` or `find_*`. Downstream reporting code resolves accessors by that prefix,
so a differently-named accessor is invisible to it.

Accessors return entries sorted by `date` ascending, then by `id` ascending as the
tie-break. The tie-break is not optional: two entries can share a date, and unstable
ordering makes month-end reconciliation non-reproducible.
