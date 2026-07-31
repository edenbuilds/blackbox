// Did this session read something outside its own worktree?
//
// Ported from agentloop's bench/leakscan.py, selftest and all. That file exists
// because it started as a heredoc that got patched four times in one afternoon —
// three of those patches RELAXED it, and a detector that only ever gets looser,
// with nothing asserting the tight cases still fire, is how a benchmark starts
// publishing contaminated runs while reporting itself clean.
//
// Reading is not listing, and only one of them moves the answer. `ls`, `find` and
// glob reveal file NAMES; `cat`, `sed`, `rg`, `sqlite3`, `strings` reveal CONTENT.
// Content reads void a run. Listings are recorded and void nothing.

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const SAFE = ["/usr/", "/bin/", "/sbin/", "/etc/", "/dev/", "/opt/", "/Library/",
  "/System/", "/Applications/", "/private/etc/", "/private/var/db/"];
const NOISE = ["TemporaryItems", "com.apple.", "/.Trash"];

const READ = /\b(cat|sed|head|tail|less|more|rg|grep|egrep|awk|strings|sqlite3|xxd|od|python3?|node|read_files|view_file|open_file|Read|Grep)\b/;
const LIST = /\b(ls|find|file_glob|tree|stat|wc|glob|Glob)\b/;
const PATH = /\/(?:Users|tmp|private\/tmp|var\/folders|private\/var\/folders)\/[\w./@%+-]+/g;

// Sidecars belong to the run. Claude spills large tool results into its scratch
// home; every arm needs its own config. A session reading its own plumbing is not
// a session reading the answer key.
const SIDECARS = [".home", ".codex-home", ".db", ".mcp.json"];

const norm = (p) => p.replace(/\/{2,}/g, "/");

// Python's Path.resolve() follows symlinks — on macOS /tmp is a symlink to
// /private/tmp, so a worktree has two real spellings and a log may echo either.
// path.resolve() alone does NOT follow symlinks, which would silently halve the
// variant set and let a genuine leak through under the other spelling.
function physical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // a path that does not exist still normalises
  }
}

// How agent CLIs name a per-project scratch directory: the cwd, punctuation
// flattened to dashes.
export const slug = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");

// Every spelling of the worktree that a log might echo back: the harness's own
// dest (built from $TMPDIR, which ends in a slash, so it carries a literal `//`),
// the physical /private/var path transcripts use, and the single-slash form a
// human types. All three name one directory.
function worktreeVariants(wt) {
  const base = new Set([norm(wt), norm(physical(wt))]);
  const out = new Set(base);
  for (const v of base) for (const s of SIDECARS) out.add(v + s);
  return [...out];
}

// Scratch directories this run's own agent created, named after its cwd. Claude
// Code keeps per-session working files under /private/tmp/claude-<uid>/<slug>/,
// so a session reading its own background-task output is reading something it
// wrote.
//
// Deliberately keyed to THIS worktree's slug and nothing broader: the operator's
// scratchpad lives one directory over under a different slug, and it holds
// whatever the operator has been printing — retrieved memory included. That one
// must keep voiding.
function ownScratchSlugs(wt) {
  return [slug(norm(wt)), slug(norm(physical(wt)))];
}

export function classify(text, wt, exists = existsSync) {
  const reads = new Set();
  const lists = new Set();
  const variants = worktreeVariants(wt);
  const own = ownScratchSlugs(wt);

  for (const line of String(text).split("\n")) {
    const found = new Set();
    for (const raw of line.match(PATH) || []) {
      const p = raw.split(":")[0];
      if (SAFE.some((s) => p.startsWith(s))) continue;
      if (NOISE.some((n) => p.includes(n))) continue;
      if (variants.some((v) => norm(p).includes(v))) continue;
      if (own.some((s) => p.includes(s))) continue;
      // A path that does not exist cannot have carried an answer. The model
      // guessed /Users/user/project/ledger/recurring.py, got "No such file or
      // directory", and that was booked as a content read. Safe only because the
      // stale-answer preflight runs before every cell: a real copy of the answer
      // is proven absent rather than assumed away.
      if (!exists(p)) continue;
      found.add(p);
    }
    const rel = /\s\.\.(?:\/|\b)/.test(line);
    if (!found.size && !rel) continue;
    if (rel) found.add("(above the worktree)");

    if (READ.test(line)) for (const f of found) reads.add(f);
    else if (LIST.test(line)) for (const f of found) lists.add(f);
    else for (const f of found) reads.add(f); // unclassified access counts as a read
  }
  return { reads: [...reads].sort(), lists: [...lists].sort() };
}

// The 13 cases from the original, unchanged. Six routes that must always void,
// five false positives that voided a clean 29/29 run and must never void again,
// and the read-vs-list distinction.
export function selftest() {
  const wt = "/var/folders/xx/AAA/T//proof-wk/w/deadbeef";
  const real = new Set([
    "/Users/omkar/agentloop/bench/tasks/t6-coldstart-naming/verify_tests.py",
    "/private/tmp/diagA/deadbeef/ledger/recurring.py",
    "/var/folders/xx/AAA/T/proof-wk/w/sibling/ledger/recurring.py",
    "/Users/omkar/marshal/marshald.py",
    "/private/tmp/wt5/ledger/alerts.py",
    "/var/folders/xx/AAA/T/proof-wk/w/deadbeef.mcp.json",
    "/var/folders/xx/AAA/T/proof-wk/w/deadbeef.home/.claude/projects/x/tool-results/a.txt",
    "/var/folders/xx/AAA/T/proof-wk/w/deadbeef/ledger/recurring.py",
    "/private/tmp/claude-501/-var-folders-xx-AAA-T-proof-wk-w-deadbeef/s1/tasks/a.output",
    "/private/tmp/claude-501/-Users-omkar/operator-session/tasks/b.output",
  ].map(norm));
  const ex = (p) => real.has(norm(p));

  const fails = [];
  const check = (name, line, wantVoid) => {
    const { reads } = classify(line, wt, ex);
    if (Boolean(reads.length) !== wantVoid) {
      fails.push(`${name}: expected void=${wantVoid}, got ${JSON.stringify(reads)}`);
    }
  };

  // The contamination routes. Every one must still void.
  check("route 1 repo checkout",
    "cat /Users/omkar/agentloop/bench/tasks/t6-coldstart-naming/verify_tests.py", true);
  check("route 2 operator scratch copy",
    "sed -n 1,50p /private/tmp/diagA/deadbeef/ledger/recurring.py", true);
  check("route 3 sibling worktree",
    "rg label /var/folders/xx/AAA/T/proof-wk/w/sibling/ledger/recurring.py", true);
  check("route 4 home glob",
    "grep -r by_label /Users/omkar/marshal/marshald.py", true);
  check("route 5 stale /tmp worktree",
    "cat /private/tmp/wt5/ledger/alerts.py", true);
  check("relative escape", "cat ../ledger/recurring.py", true);

  // The false positives that voided a clean run. None may void.
  check("own mcp config",
    "claude --mcp-config /var/folders/xx/AAA/T//proof-wk/w/deadbeef.mcp.json", false);
  check("own scratch home spill",
    "cat /var/folders/xx/AAA/T/proof-wk/w/deadbeef.home/.claude/projects/x/tool-results/a.txt", false);
  check("hallucinated path", "cat /Users/user/project/ledger/recurring.py", false);
  check("own worktree, physical spelling",
    "cat /var/folders/xx/AAA/T/proof-wk/w/deadbeef/ledger/recurring.py", false);

  // The agent's own scratchpad is named after its cwd; the operator's is not, and
  // the operator's holds whatever they have been printing.
  check("own session scratchpad",
    "cat /private/tmp/claude-501/-var-folders-xx-AAA-T-proof-wk-w-deadbeef/s1/tasks/a.output", false);
  check("operator's session scratchpad",
    "cat /private/tmp/claude-501/-Users-omkar/operator-session/tasks/b.output", true);

  // Listing is not reading: names transfer nothing.
  {
    const { reads, lists } = classify("ls /private/tmp/wt5/ledger/alerts.py", wt, ex);
    if (reads.length || !lists.length) {
      fails.push(`listing must not void: reads=${JSON.stringify(reads)} lists=${JSON.stringify(lists)}`);
    }
  }

  for (const f of fails) console.log("FAIL " + f);
  console.log(`leakscan selftest ${fails.length ? "FAILED" : "PASSED"} (${13 - fails.length}/13)`);
  return fails.length ? 1 : 0;
}
