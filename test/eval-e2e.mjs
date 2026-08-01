// End-to-end exercise of the evaluator with no model call.
//
// A bug in the runner silently corrupts every published number, so the plumbing —
// guards, materialisation, arm installs, verify, leak scan, scoring — has to be
// testable for free. The stub executor makes the pipeline runnable in CI; only the
// model call is replaced.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpec, runSuite, score } from "../lib/eval.mjs";
import { SCRATCH } from "../lib/isolate.mjs";

let fails = 0;
let total = 0;
const check = (name, got, want) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};

// The fixture lives in a temp dir, not in the repo: runsDir must have no CLAUDE.md
// or AGENTS.md above it, and this repo — like most — has one at its root.
const root = mkdtempSync(join(process.env.TMPDIR || "/tmp", "bbe2e-"));
const specDir = join(root, "spec");
mkdirSync(join(specDir, "tasks", "echo", "seed"), { recursive: true });

// The seed is what every arm starts from.
writeFileSync(join(specDir, "tasks", "echo", "seed", "README.md"), "# fixture\n");
// The configured arm installs this; the bare arm does not.
writeFileSync(join(specDir, "helper.md"), "the convention is: write ok\n");

const spec = {
  runsDir: join(root, "runs"),
  executor: "stub",
  reps: 1,
  arms: {
    bare: { install: [] },
    configured: { install: ["helper.md"] },
  },
  tasks: [{
    id: "echo",
    seed: "tasks/echo/seed",
    prompt: "write ok into answer.txt",
    verify: 'test "$(cat answer.txt 2>/dev/null)" = ok',
    answerNames: ["answer-key.txt"],
  }],
};
writeFileSync(join(specDir, "blackbox.eval.json"), JSON.stringify(spec, null, 2));

// The stub succeeds only when the arm actually installed its config — the whole
// point of an arm being a set of files rather than a label.
process.env.BLACKBOX_STUB_SCRIPT = `
  const fs = require("fs");
  const ok = fs.existsSync(join(dest, "helper.md"));
  fs.writeFileSync(join(dest, "answer.txt"), ok ? "ok" : "no");
`;

const loaded = loadSpec(join(specDir, "blackbox.eval.json"));
const results = runSuite({ spec: loaded, onLog: () => {} });
const scored = score(results);

check("one cell per arm", results.length, 2);
check("bare arm fails without its config", scored.bare.pass_rate, 0);
check("configured arm passes", scored.configured.pass_rate, 1);
check("nothing was voided by the leak detector", [scored.bare.void, scored.configured.void], [0, 0]);
check("nothing was blocked by a guard", [scored.bare.blocked, scored.configured.blocked], [0, 0]);
check("both cells actually ran", results.every((r) => r.ran), true);

// A failing cell keeps its verify output; a passing one does not carry the noise.
check("failing cell retains verify output", typeof results.find((r) => !r.passed).verify_output, "string");
check("passing cell has no verify output", results.find((r) => r.passed).verify_output, null);

// Only one worktree may exist at a time — a sibling is readable from the live cell,
// and that is exactly how the original suite leaked an answer between runs. Checked
// here, after a suite that ran: a blocked cell purges and then never creates one, so
// zero is also correct there and would make this assertion meaningless.
{
  const { readdirSync } = await import("node:fs");
  // Sidecars (.home, .mcp.json) sit beside the worktree in the same directory and
  // are not themselves worktrees.
  const worktrees = readdirSync(join(loaded.runsDir, "w")).filter((n) => !n.includes("."));
  check("exactly one worktree survives a completed suite", worktrees.length, 1);
}

// The guards must refuse rather than run when the answer is reachable.
{
  const stale = mkdtempSync(join(SCRATCH, "bbstale-"));
  writeFileSync(join(stale, "answer-key.txt"), "ok\n");
  const blocked = runSuite({ spec: loaded, filter: { arm: "bare" }, onLog: () => {} });
  check("a reachable answer blocks the cell instead of running it",
    [blocked[0].ran, Boolean(blocked[0].blocked)], [false, true]);
  rmSync(stale, { recursive: true, force: true });
  // And nothing was left behind by the cell that refused to start.
  const { readdirSync } = await import("node:fs");
  check("a blocked cell leaves no worktree",
    readdirSync(join(loaded.runsDir, "w")).filter((n) => !n.includes(".")).length, 0);
}

// A cell whose executor errored before doing any work is dead, not failed — and a
// dead cell must not be averaged into a pass rate. This is the exact shape of the
// first real run: the CLI exited 0 while reporting "Not logged in" in its output, so
// the exit status alone called it a legitimate failure of the configuration.
{
  const { score } = await import("../lib/eval.mjs");
  const s = score([
    { arm: "bare", ran: false, passed: false, void: false, error: "Not logged in" },
    { arm: "bare", ran: true, passed: true, void: false },
  ]);
  check("a dead cell is counted separately", s.bare.dead, 1);
  check("a dead cell is excluded from the rate", [s.bare.scored, s.bare.pass_rate], [1, 1]);
}

// The preflight refuses rather than billing cells that cannot produce a number.
{
  const { preflight } = await import("../lib/eval.mjs");
  const saved = {
    a: process.env.ANTHROPIC_API_KEY,
    b: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    c: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  let refused = false;
  try {
    preflight({ executor: "claude" });
  } catch (e) {
    refused = /headless credential/.test(e.message);
  }
  check("preflight refuses a claude run with no headless credential", refused, true);

  process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
  let passed = true;
  try {
    preflight({ executor: "claude" });
  } catch (e) {
    passed = !/headless credential/.test(e.message); // CLI-missing is a different refusal
  }
  check("preflight accepts a credential from the environment", passed, true);

  delete process.env.ANTHROPIC_API_KEY;
  for (const [k, v] of [["ANTHROPIC_API_KEY", saved.a], ["CLAUDE_CODE_OAUTH_TOKEN", saved.b], ["ANTHROPIC_AUTH_TOKEN", saved.c]]) {
    if (v !== undefined) process.env[k] = v;
  }
}

// The spend cap stops the suite between cells. Without this, a suite of N cells runs
// all N and nothing stops at $X — the one honest gap the audit named in blackbox.
{
  const { score } = await import("../lib/eval.mjs");
  // The stub reports no cost, so drive the accounting directly: a suite whose first
  // cell already exceeded the cap must skip the rest rather than run them.
  const s = score([
    { arm: "bare", ran: true, passed: true, void: false, cost_usd: 5 },
    { arm: "bare", ran: false, passed: false, void: false, skipped: "cost cap reached: $5.00 of $1" },
    { arm: "bare", ran: false, passed: false, void: false, skipped: "cost cap reached: $5.00 of $1" },
  ]);
  check("skipped cells are counted separately", s.bare.skipped, 2);
  check("skipped cells are excluded from the rate", [s.bare.scored, s.bare.pass_rate], [1, 1]);
}

// And end to end: a zero budget must stop the suite before the first cell runs.
{
  const capped = loadSpec(join(specDir, "blackbox.eval.json"));
  capped.maxCostUsd = 0;
  const out = runSuite({ spec: capped, onLog: () => {} });
  check("a zero cost cap skips every cell", out.every((r) => Boolean(r.skipped)), true);
  check("nothing ran under a zero cap", out.some((r) => r.ran), false);
}

rmSync(root, { recursive: true, force: true });
console.log(fails ? `\neval e2e FAILED (${fails})` : `\neval e2e PASSED (${total}/${total})`);
process.exit(fails ? 1 : 0);
