// Guards that run before a model does.
//
// Ported from agentloop's proof.sh. Every one of these exists because a benchmark
// published a number it should not have, and the comments name the specific run.
// Detection after the fact voids a suite and costs real money; these cost nothing.

import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class IsolationError extends Error {}

// Anonymous, content-addressed worktree names. Not security — `find ..` enumerates
// directories regardless of what they are called — but it keeps the cell's identity
// (task, arm, rep) out of the path, which the agent CLI otherwise echoes into its
// own scratch directory name and into transcripts.
export function runDir(runsRoot, ...parts) {
  const h = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
  return join(runsRoot, "w", h);
}

// How agent CLIs name a per-project scratch directory.
const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");

// A bare arm is only bare if nothing above it configures an agent. Codex and Claude
// Code both walk ancestors for AGENTS.md/CLAUDE.md, so an unlucky runs directory
// silently loads the harness into the control arm. Refuse to run rather than publish
// a number produced under contamination.
export function assertIsolated(dest) {
  const found = [];
  let d = resolve(dirname(dest));
  while (d !== "/") {
    for (const f of ["AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
      if (existsSync(join(d, f))) found.push(join(d, f));
    }
    d = dirname(d);
  }
  if (found.length) {
    throw new IsolationError(
      `run directory is not isolated — agent config found above it:\n` +
      found.map((f) => `  ${f}`).join("\n") +
      `\n  Both CLIs read ancestor config, so the control arm would not be bare.` +
      `\n  Set runsDir to a path with no AGENTS.md/CLAUDE.md above it.`,
    );
  }
}

// Exactly one worktree exists at a time, and everything else is deleted before a run
// starts.
//
// This is not tidiness. With every worktree under one parent, a session reads its
// neighbours: one run found the answer and the next two lifted it straight out of the
// sibling directory. Anonymous names do nothing against that — `find ..` enumerates
// them regardless. The only property that holds is that there is nothing to find.
export function purgeWorktrees(runsRoot, keep = null) {
  const w = join(runsRoot, "w");
  if (!existsSync(w)) return 0;
  let n = 0;
  const keepName = keep ? basename(keep) : null;
  for (const name of readdirSync(w)) {
    const d = join(w, name);
    // Sidecars (.home, .codex-home, .db, .mcp.json) live beside the worktree, so a
    // plain `d === keep` test would spare the kept worktree and then delete its own
    // scratch home on the next iteration — logging the agent out mid-suite.
    if (keepName && name.startsWith(keepName)) continue;
    for (const suffix of ["", ".home", ".codex-home", ".db", ".db-wal", ".db-shm", ".mcp.json"]) {
      rmSync(d + suffix, { recursive: true, force: true });
    }
    // Route 6: the agent CLI's own scratchpad outlives the worktree. Claude Code
    // keeps per-session working files under /private/tmp/claude-<uid>/<slug-of-cwd>/,
    // OUTSIDE the runs dir, so purging the worktree left them behind — four were
    // found holding retrieved memory verbatim, including the exact convention the
    // task turned on. Deleting the worktree and leaving its transcript of the answer
    // next door is not isolation.
    const slug = slugFor(resolve(d));
    for (const root of ["/private/tmp", "/tmp"]) {
      if (!existsSync(root)) continue;
      for (const entry of safeReaddir(root)) {
        if (!entry.startsWith("claude-")) continue;
        const scratch = join(root, entry, slug);
        if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
      }
    }
    n++;
  }
  return n;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Depth-bounded walk. The bound is not decoration: a naive recursive grep over the
// scratch roots took more than two minutes per cell, and a preflight that costs more
// than the run it guards gets switched off.
function* walk(root, maxDepth, depth = 0) {
  if (depth > maxDepth || !existsSync(root)) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isSymbolicLink()) continue; // a symlink can walk us back out of the bound
    if (e.isDirectory()) yield* walk(full, maxDepth, depth + 1);
    else if (e.isFile()) yield full;
  }
}

const TEXTLIKE = /\.(output|log|md|txt|py|json|jsonl|ts|js|mjs)$/;

// Refuse to start when a copy of this task's answer is sitting in a scratch
// directory. Found the hard way: a worktree left in /private/tmp from a previous day
// held a fully implemented answer, tie-break convention and all. A session ran
// `find /private/tmp`, read it, and passed — a pass that had nothing to do with the
// thing under test.
export function assertNoStaleAnswers({ answerNames = [], contentKeys = [], runsRoot }) {
  const roots = ["/tmp", "/private/tmp", process.env.TMPDIR || "/tmp"];
  const found = [];
  const wanted = new Set(answerNames);

  for (const root of roots) {
    for (const hit of walk(root, 4)) {
      if (runsRoot && hit.startsWith(runsRoot)) continue; // the live worktree legitimately has these
      if (wanted.has(basename(hit))) found.push(hit);
    }
  }

  // Filenames are not the only way an answer sits on disk. A previous session's
  // scratchpad holds what it RETRIEVED — the accessor name, the sort order — in a
  // file called `b8c6r4srh.output`, which no filename rule will ever match. So also
  // look for the task's own distinctive keys as content. One bounded pass with all
  // keys in a single alternation, not one grep per key.
  if (contentKeys.length) {
    const pattern = new RegExp(contentKeys.map(escapeRe).join("|"));
    for (const root of roots) {
      for (const hit of walk(root, 6)) {
        if (runsRoot && hit.startsWith(runsRoot)) continue;
        if (!TEXTLIKE.test(hit)) continue;
        try {
          if (statSync(hit).size > 2_000_000) continue;
          if (pattern.test(readFileSync(hit, "utf8"))) found.push(`${hit} (contains a task key)`);
        } catch {
          continue;
        }
        if (found.length > 20) break;
      }
    }
  }

  if (found.length) {
    throw new IsolationError(
      `a copy of this task's answer is reachable in a scratch directory:\n` +
      [...new Set(found)].map((f) => `  ${f}`).join("\n") +
      `\n  A session that finds one of these passes without using the thing under test.` +
      `\n  Delete them, or set runsDir somewhere they are not reachable.` +
      `\n  Nothing was run and nothing was billed.`,
    );
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function selftest() {
  const fails = [];
  const check = (name, fn) => {
    try {
      fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`);
      fails.push(name);
    }
  };
  const throws = (fn) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof IsolationError) return;
      throw e;
    }
    throw new Error("expected an IsolationError, got none");
  };

  const tmp = mkdtempSync(join(process.env.TMPDIR || "/tmp", "bbiso-"));

  check("runDir is stable and anonymous", () => {
    const a = runDir(tmp, "t1", "A", "1");
    if (a !== runDir(tmp, "t1", "A", "1")) throw new Error("not stable");
    if (a === runDir(tmp, "t1", "B", "1")) throw new Error("collides across arms");
    if (/t1|A/.test(basename(a))) throw new Error("cell identity leaked into the path");
  });

  check("assertIsolated rejects agent config above the run dir", () => {
    const parent = join(tmp, "guarded");
    mkdirSync(join(parent, "w"), { recursive: true });
    writeFileSync(join(parent, "CLAUDE.md"), "# would load into the control arm\n");
    throws(() => assertIsolated(join(parent, "w", "cell")));
  });

  check("assertNoStaleAnswers catches an answer file by name", () => {
    const scratch = mkdtempSync(join("/private/tmp", "bbstale-"));
    writeFileSync(join(scratch, "verify_tests.py"), "# the answer key\n");
    throws(() => assertNoStaleAnswers({ answerNames: ["verify_tests.py"], runsRoot: tmp }));
    rmSync(scratch, { recursive: true, force: true });
  });

  check("assertNoStaleAnswers catches a retrieved key by content", () => {
    const scratch = mkdtempSync(join("/private/tmp", "bbstale-"));
    // The shape that no filename rule matches: a scratchpad holding what a previous
    // session retrieved.
    writeFileSync(join(scratch, "b8c6r4srh.output"), "decided: recurring-accessor-by-label\n");
    throws(() => assertNoStaleAnswers({ contentKeys: ["recurring-accessor-by-label"], runsRoot: tmp }));
    rmSync(scratch, { recursive: true, force: true });
  });

  check("a clean machine passes", () => {
    assertNoStaleAnswers({ answerNames: ["a-name-nothing-on-disk-has.py"], runsRoot: tmp });
  });

  check("purgeWorktrees removes siblings and their sidecars", () => {
    const runs = join(tmp, "runs");
    const a = runDir(runs, "t", "A", "1");
    const b = runDir(runs, "t", "B", "1");
    for (const d of [a, b]) mkdirSync(d, { recursive: true });
    writeFileSync(a + ".mcp.json", "{}");
    mkdirSync(b + ".home", { recursive: true });
    purgeWorktrees(runs, a);
    if (!existsSync(a)) throw new Error("kept worktree was deleted");
    if (existsSync(b)) throw new Error("sibling worktree survived — it is readable from the live cell");
    if (existsSync(b + ".home")) throw new Error("sibling scratch home survived");
  });

  check("purgeWorktrees keeps the kept worktree's own sidecars", () => {
    const runs = join(tmp, "runs2");
    const a = runDir(runs, "t", "A", "1");
    mkdirSync(a + ".home", { recursive: true });
    mkdirSync(a, { recursive: true });
    writeFileSync(a + ".mcp.json", "{}");
    purgeWorktrees(runs, a);
    // Matching on the directory alone would spare `a` and then delete `a.home` on
    // the next iteration, logging the agent out in the middle of its own cell.
    if (!existsSync(a + ".home")) throw new Error("kept worktree's scratch home was deleted");
    if (!existsSync(a + ".mcp.json")) throw new Error("kept worktree's mcp config was deleted");
  });

  rmSync(tmp, { recursive: true, force: true });
  console.log(fails.length ? `\nisolate selftest FAILED (${fails.length})` : "\nisolate selftest PASSED (7/7)");
  return fails.length ? 1 : 0;
}
