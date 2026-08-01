// Does this repo's agent config enforce anything, or only ask?
//
// Every agent harness declares controls — max_turns, cost caps, approval gates,
// permission tiers. Almost none of them execute. The gap between a control being
// DECLARED and a control being CALLED is invisible by inspection and trivial to
// compute, which is what this does.
//
// It was written after auditing agentloop by hand and finding 32 lines of enforcement
// behind 3,711 lines of doctrine, with the single enforcement primitive having zero
// callers — a fuse manufactured and never installed. That is not an unusual result.
// It is the default state of a prompt pack that grew controls in markdown.
//
// This is deliberately a static analysis. It reads files and greps; it runs nothing,
// spends nothing, and needs no credentials.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const CODE_EXT = new Set([".sh", ".bash", ".mjs", ".js", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs"]);
const DOC_EXT = new Set([".md", ".mdc", ".mdx", ".txt", ".yaml", ".yml"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "venv", ".venv", "results", "runs"]);

// Controls worth asking about, and where each is conventionally declared. The point is
// not an exhaustive taxonomy — it is the handful that cost real money when absent.
const CONTROLS = [
  { id: "max_turns", label: "turn cap", patterns: [/\bmax_turns\b/], why: "an agent that never stops" },
  { id: "max_cost", label: "cost cap", patterns: [/\bmax_cost(_usd)?\b/, /\bbudget\b.*\b(usd|cost|token)\b/i], why: "an unbounded bill" },
  { id: "timeout", label: "timeout", patterns: [/\btimeout\b/], why: "a hung run nobody notices" },
  { id: "no_progress", label: "no-progress detection", patterns: [/\bno_progress\b/], why: "grinding without advancing" },
  { id: "approval", label: "approval gate", patterns: [/\bauto_approve\w*\b/, /\bapproval_required\b/], why: "unattended action outside scope" },
  { id: "permissions", label: "permission tiers", patterns: [/\bpermission[_ ]?(tier|matrix|mode)\b/i, /\ballowlist\b/i], why: "tool access nobody bounded" },
  { id: "swarm_caps", label: "swarm caps", patterns: [/\bmax_workers\b/, /\bmax_depth\b/], why: "recursive spawning" },
  { id: "sandbox", label: "sandbox", patterns: [/\bsandbox\b/, /\bseccomp\b/], why: "an agent reading the whole disk" },
];

// A file that can change a run's outcome, as opposed to one that describes it.
const isCode = (f) => CODE_EXT.has(extname(f));
const isDoc = (f) => DOC_EXT.has(extname(f));

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && !["\.agentloop", ".claude", ".cursor", ".github"].includes(e.name)) {
      if (![".agentloop", ".claude", ".cursor", ".github"].includes(e.name)) continue;
    }
    if (SKIP_DIR.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

function collect(root) {
  const code = [];
  const docs = [];
  for (const f of walk(root)) {
    try {
      if (statSync(f).size > 1_000_000) continue;
    } catch {
      continue;
    }
    if (isCode(f)) code.push(f);
    else if (isDoc(f)) docs.push(f);
  }
  return { code, docs };
}

const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

const countLines = (files) => files.reduce((n, f) => n + read(f).split("\n").length, 0);

// A control is ENFORCED only if it appears in code that can actually stop something.
// Mentioning `max_turns` in a shell script that prints it is not enforcement, so the
// hit must sit near an exit, a throw, or a non-zero return.
const STOPS = /\b(exit\s+[1-9]|sys\.exit\(|process\.exit\(|throw new|return\s+2\b|\bdie\b|abort)/;

// A mention that is explicitly turning the control OFF, or admitting it is absent.
// `--dangerously-bypass-approvals-and-sandbox` contains "sandbox" and is the opposite
// of sandboxing; counting it as enforcement is how a detector flatters its subject.
const NEGATED = /(bypass|disable|dangerously|--no-|\bno\b[- ]sandbox|not implemented|advisory|deprecated|TODO|unenforced)/i;

// Comment lines are where doctrine hides inside code files. A shell comment explaining
// that max_turns should be capped is still doctrine, not a cap.
const COMMENT = /^\s*(#|\/\/|\*|<!--)/;

const WINDOW = 12; // lines either side; a stop further away than this is a different concern

function analyseControl(control, code, docs) {
  const declaredIn = [];
  const codeHits = [];
  const enforcingAt = [];
  const unclearAt = [];
  let enforcementLines = 0;

  for (const f of docs) {
    const t = read(f);
    if (control.patterns.some((p) => p.test(t))) declaredIn.push(f);
  }

  for (const f of code) {
    const lines = read(f).split("\n");
    let fileHit = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!control.patterns.some((p) => p.test(line))) continue;
      if (COMMENT.test(line)) continue;   // doctrine in a code file is still doctrine
      if (NEGATED.test(line)) continue;   // a flag that disables it is not enforcement
      fileHit = true;
      // The stopping construct must be near the control, not merely somewhere in a
      // 1,300-line script that also happens to call exit.
      const from = Math.max(0, i - WINDOW);
      const to = Math.min(lines.length, i + WINDOW + 1);
      const near = lines.slice(from, to).filter((l) => !COMMENT.test(l)).join("\n");
      if (STOPS.test(near)) {
        enforcingAt.push(`${f}:${i + 1}`);
        enforcementLines += to - from;
      }
    }
    // The control appears in a file that stops somewhere, but not near this line.
    // Real enforcement is often split across functions — state.sh parses max_turns in
    // one and exits 2 in another — so this is genuinely unknown rather than absent,
    // and saying "not enforced" would be as wrong as saying "enforced".
    if (fileHit && !enforcingAt.length && STOPS.test(read(f))) unclearAt.push(f);
    if (fileHit) codeHits.push(f);
  }

  const state = enforcingAt.length ? "enforced" : unclearAt.length ? "unclear" : codeHits.length ? "inert" : "absent";

  return {
    id: control.id,
    label: control.label,
    why: control.why,
    state,
    declared: declaredIn.length > 0,
    inCode: codeHits.length > 0,
    enforced: enforcingAt.length > 0,
    unclearAt: unclearAt.slice(0, 3),
    enforcementLines,
    declaredIn,
    codeHits,
    enforcingAt: enforcingAt.slice(0, 3),
  };
}

// The interception points that make enforcement possible at all. Without one of these,
// a harness cannot stop a run no matter what its config says — the control has nowhere
// to fire from.
function analyseHooks(root) {
  const candidates = [
    join(root, "hooks", "hooks.json"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ];
  const found = [];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let j;
    try {
      j = JSON.parse(read(p));
    } catch {
      found.push({ file: p, events: [], malformed: "not valid JSON" });
      continue;
    }
    const hooks = j.hooks || j;
    const events = Object.keys(hooks).filter((k) => /^[A-Za-z]+$/.test(k));
    // Capitalisation is load-bearing: `sessionStart` does not match `SessionStart`, and
    // a plugin whose events never match is a plugin whose hooks have never fired. This
    // exact defect hid in agentloop for the life of the repo.
    const miscased = events.filter((e) => /^[a-z]/.test(e));
    found.push({ file: p, events, miscased });
  }
  return found;
}

const INTERCEPTION = ["PreToolUse", "PostToolUse", "Stop", "SubagentStop"];

export function audit(root) {
  const { code, docs } = collect(root);
  const controls = CONTROLS.map((c) => analyseControl(c, code, docs));
  const hooks = analyseHooks(root);

  // Enforcement LOC is the sum of the measured windows around real enforcing lines.
  // Counting whole files put proof.sh's 1,366 lines in the numerator and reported a
  // flattering 1:3 for a repo whose true ratio was 1:116.
  const enforcementLines = controls.reduce((n, c) => n + c.enforcementLines, 0);

  const events = hooks.flatMap((h) => h.events);
  const interception = events.filter((e) => INTERCEPTION.includes(e));

  return {
    root,
    controls,
    hooks,
    interception,
    loc: {
      code: countLines(code),
      docs: countLines(docs),
      enforcement: enforcementLines,
    },
    counts: {
      declared: controls.filter((c) => c.declared || c.inCode).length,
      enforced: controls.filter((c) => c.state === "enforced").length,
      unclear: controls.filter((c) => c.state === "unclear").length,
    },
  };
}

export function formatAudit(a) {
  const L = [];
  const mark = (ok) => (ok ? "✓" : "✗");

  L.push(`agent control audit — ${a.root}`);
  L.push("");
  L.push(`harness    ${a.counts.enforced} of ${a.counts.declared} declared controls enforced in code`);
  for (const c of a.controls) {
    if (!c.declared && !c.inCode) continue;
    const glyph = { enforced: "✓", unclear: "?", inert: "✗", absent: "✗" }[c.state];
    const words = {
      enforced: "enforced — stops the run",
      unclear: `unclear — in ${c.unclearAt.map((f) => f.split("/").pop()).join(", ")}, verify by hand`,
      inert: "referenced in code, but nothing stops on it",
      absent: "declared in config/docs only, no code reads it",
    }[c.state];
    L.push(`           ${glyph} ${c.label.padEnd(22)} ${words}`);
  }

  L.push("");
  if (!a.hooks.length) {
    L.push("hooks      none found — there is no interception point, so nothing can be stopped");
  } else {
    for (const h of a.hooks) {
      const rel = relative(a.root, h.file) || h.file;
      if (h.malformed) {
        L.push(`hooks      ${rel}: ${h.malformed}`);
        continue;
      }
      L.push(`hooks      ${rel}: ${h.events.join(", ") || "(no events)"}`);
      if (h.miscased?.length) {
        L.push(`           ✗ miscased event(s): ${h.miscased.join(", ")} — these never match and never fire`);
      }
    }
    if (!a.interception.length) {
      L.push("           ✗ no PreToolUse/PostToolUse/Stop — nothing can interrupt a run mid-flight");
    } else {
      L.push(`           ✓ interception at ${a.interception.join(", ")}`);
    }
  }

  L.push("");
  const { enforcement, docs } = a.loc;
  const ratio = enforcement > 0 ? Math.round(docs / enforcement) : null;
  L.push(`enforcement ${enforcement} LOC   doctrine ${docs} LOC   ` +
    (ratio === null ? "ratio n/a (no enforcement found)" : `ratio 1:${ratio}`));

  if (a.counts.unclear) {
    L.push(`           ${a.counts.unclear} control(s) unclear — enforcement split across functions defeats a`);
    L.push("           local check. These need a human, and are counted as neither.");
  }

  const gaps = a.controls.filter((c) => (c.declared || c.inCode) && c.state !== "enforced" && c.state !== "unclear");
  if (gaps.length) {
    L.push("");
    L.push("What each gap costs you:");
    for (const g of gaps) L.push(`  ${g.label.padEnd(22)} ${g.why}`);
  }

  L.push("");
  L.push("Static analysis only — nothing was run and nothing was billed. A control counted");
  L.push("as enforced appears in code alongside a stopping construct; that it is reachable");
  L.push("from a real entry point still needs a human to confirm.");
  return L.join("\n");
}

export function selftest() {
  let fails = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
    if (!ok) fails++;
  };

  // A control declared in markdown but absent from code is the default failure mode,
  // and must not be reported as enforced.
  const docOnly = analyseControl(CONTROLS[0], [], ["/fake/AGENTS.md"]);
  check("a control with no files at all is not enforced", docOnly.enforced, false);

  // Capitalisation detection — the defect that hid in agentloop for the life of the repo.
  const miscased = ["sessionStart", "PostToolUse"].filter((e) => /^[a-z]/.test(e));
  check("miscased hook events are detected", miscased, ["sessionStart"]);

  // The stopping-construct heuristic must reject a script that merely prints a cap.
  check("printing a cap is not enforcing it", STOPS.test('echo "max_turns: $cap"'), false);
  check("a non-zero exit counts as enforcement", STOPS.test("if over; then exit 2; fi"), true);
  check("a throw counts as enforcement", STOPS.test("throw new Error('over budget')"), true);

  check("a disabling flag is not enforcement", NEGATED.test("--dangerously-bypass-approvals-and-sandbox"), true);
  check("a comment is not enforcement", COMMENT.test("  # max_turns should stop the run"), true);
  check("an advisory admission is not enforcement", NEGATED.test("stop.yaml is advisory here"), true);

  console.log(fails ? `\naudit selftest FAILED (${fails})` : "\naudit selftest PASSED (8/8)");
  return fails ? 1 : 0;
}
