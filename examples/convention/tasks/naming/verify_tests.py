"""The answer key.

Lives outside the worktree until verify time: a copy sitting in the worktree while
the model runs is contamination route 1, and the stale-answer guard blocks the run
if a copy is reachable anywhere else either.

Plain asserts, no pytest — a benchmark that needs a pip install before it can score
is a benchmark people skip.
"""
import sys

sys.path.insert(0, ".")
import ledger.recurring as r

assert hasattr(r, "for_label"), "expected an accessor named for_label (the documented convention)"
assert [e["id"] for e in r.for_label("utilities")] == [2], "wrong entries returned"
# Three rent entries, two sharing a date. Without the documented id tie-break, the
# order of ids 1 and 3 is whatever the source list happened to be in.
assert [e["id"] for e in r.for_label("rent")] == [1, 3, 4], "not sorted by date then id"
print("ok")
