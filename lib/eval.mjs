// Paired A/B evaluation of agent configurations.
//
// The question: does your CLAUDE.md / skill pack / MCP setup actually help? Run the
// same task with it and without it, in isolated worktrees, and compare pass rate and
// cost. Ported from agentloop's proof.sh, generalised so an "arm" is whatever files
// you install into the worktree rather than a hardcoded harness.
//
// What makes a result trustworthy is not the runner, it is the guards in
// ./isolate.mjs and the detector in ./leakscan.mjs. The original suite had to void a
// 30-run batch because five of six control runs read the answer key out of their own
// cwd. Those guards are why; do not route around them.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertIsolated, assertNoStaleAnswers, purgeWorktrees, runDir } from "./isolate.mjs";
import { classify } from "./leakscan.mjs";
import { claudeTranscripts, loadPricing, reduceClaude, summarise } from "./record.mjs";

const DEFAULTS = {
  executor: "claude",
  model: "claude-sonnet-5",
  reps: 1,
  timeoutSec: 900,
};

export function loadSpec(path) {
  const spec = { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
  spec.dir = dirname(resolve(path));
  spec.runsDir = resolve(spec.runsDir || join(process.env.TMPDIR || "/tmp", "blackbox-eval"));

  if (!spec.arms || Object.keys(spec.arms).length < 2) {
    throw new Error("spec needs at least two arms — a comparison of one thing is not a comparison");
  }
  if (!spec.tasks?.length) throw new Error("spec needs at least one task");
  for (const t of spec.tasks) {
    if (!t.id) throw new Error("every task needs an id");
    if (!t.verify) {
      // A task whose success cannot be checked by a command produces a number that
      // means nothing. This is the same rule the harness applies to its own plans.
      throw new Error(`task ${t.id} has no verify command — an unverifiable task cannot be scored`);
    }
  }
  return spec;
}

// ---------------------------------------------------------------- executors

const EXECUTORS = {
  // Two flags are load-bearing, not tidiness:
  //   --strict-mcp-config with an explicit (empty) config keeps the operator's own
  //     MCP servers out of the run. Without it a "bare" arm inherits every server in
  //     the user's config and stops being bare.
  //   --output-format stream-json emits one record per tool call, which is what the
  //     leak detector reads. Plain `json` returns only the final text: it would blind
  //     the detector, and a blind detector reports every contaminated run as clean.
  claude: ({ dest, prompt, model, home, mcpConfig, timeoutSec }) => ({
    cmd: "claude",
    args: [
      "-p", prompt,
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config", mcpConfig || '{"mcpServers":{}}',
      "--output-format", "stream-json",
      "--verbose",
    ],
    opts: {
      cwd: dest,
      timeout: timeoutSec * 1000,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
    },
  }),

  codex: ({ dest, prompt, model, home, timeoutSec }) => ({
    cmd: "codex",
    args: [
      "exec", "--model", model,
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ],
    opts: {
      cwd: dest,
      timeout: timeoutSec * 1000,
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
    },
  }),

  // Exercises the whole pipeline — guards, materialisation, verify, leak scan,
  // scoring — without a model call. The suite's own plumbing can then be tested in
  // CI for free, which matters because a bug in the runner silently corrupts every
  // published number.
  stub: ({ dest, prompt }) => ({
    cmd: process.execPath,
    args: ["-e", `
      const {writeFileSync,mkdirSync}=require("fs"), {join}=require("path");
      const dest=${JSON.stringify(dest)};
      const script=process.env.BLACKBOX_STUB_SCRIPT;
      if (script) { mkdirSync(join(dest,"."),{recursive:true}); eval(script); }
      console.log(JSON.stringify({type:"stub",prompt:${JSON.stringify(prompt)}}));
    `],
    opts: { cwd: dest, timeout: 30000, env: process.env },
  }),
};

// ---------------------------------------------------------------- preflight

// Refuse to start a suite that cannot possibly produce a number.
//
// Ported from proof.sh's executor_probe, which exists because of a specific bill:
// the standalone CLI does not inherit auth from Claude Desktop's agent mode, whose
// token is held in-process. Without a headless credential every cell dies at zero
// output tokens, and twenty of those cost an afternoon before anyone noticed. The
// preflight names the fix instead of letting you discover it one cell at a time.
export function preflight(spec, onLog = () => {}) {
  if (spec.executor === "stub") return;

  // Say where the calls are going, before they go. A gateway serves its own model
  // names and has its own billing, so "unknown provider for model X" and "trial
  // period expired" both arrive as opaque 4xx from a URL nobody mentioned. This
  // took three rounds to diagnose once; it should take none.
  const base = process.env.ANTHROPIC_BASE_URL;
  // Pointing ANTHROPIC_BASE_URL at Anthropic itself is still direct — calling that a
  // gateway would send someone hunting a third-party billing problem that is not there.
  const gateway = base && !/(^|\/\/)(api\.)?anthropic\.com\/?$/.test(base.replace(/\/+$/, "")) ? base : null;
  if (gateway) {
    onLog(`routing via gateway ${gateway} — model names and billing are the gateway's, not Anthropic's`);
    const named = ["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]
      .map((n) => process.env[n]).filter(Boolean);
    if (named.length && !named.includes(spec.model)) {
      onLog(`spec model "${spec.model}" is not among the gateway's configured models (${named.join(", ")})`);
    }
  } else {
    onLog("routing direct to api.anthropic.com");
  }

  const which = spawnSync("command", ["-v", spec.executor], { shell: true, encoding: "utf8" });
  if (which.status !== 0) {
    throw new Error(`${spec.executor} CLI is not on PATH`);
  }

  if (spec.executor === "claude") {
    // ANTHROPIC_AUTH_TOKEN counts: it is how the CLI authenticates against a
    // gateway, and omitting it from this check rejected a correctly configured
    // environment.
    const NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
    const cred = NAMES.map((n) => process.env[n]).find(Boolean);

    // Set-but-empty is invisible otherwise, and it is the likely outcome of a
    // mistyped `read` — the variable exists, so it looks configured, and the only
    // symptom is a refusal that reads as if nothing was set at all.
    const empty = NAMES.filter((n) => process.env[n] !== undefined && process.env[n] === "");
    if (!cred && empty.length) {
      throw new Error(
        `${empty.join(" and ")} is set but empty, so the CLI has no credential.\n` +
        `  This is what a mistyped \`read\` produces: the variable exists and the value does not.\n` +
        `  Re-run the read, and check with:  [ -n "$${empty[0]}" ] && echo set || echo empty\n` +
        `  Nothing was run and nothing was billed.`,
      );
    }
    // A credential that is present but malformed produces "401 Invalid bearer token",
    // which says nothing about which of the several plausible causes it is. Report the
    // shape — never the value — so a truncated or whitespace-mangled paste is visible
    // without anyone having to echo a secret to compare it by eye.
    if (cred) {
      const name = NAMES.find((n) => process.env[n] === cred);
      const problems = [];
      if (/\s/.test(cred)) problems.push("contains whitespace or a newline");
      if (cred.length < 20) problems.push(`is only ${cred.length} characters`);
      if (problems.length) {
        throw new Error(
          `${name} ${problems.join(" and ")}, so it is not a usable credential.\n` +
          `  Length ${cred.length}, starts "${cred.slice(0, 7)}…". A partial paste looks exactly like this.\n` +
          `  Nothing was run and nothing was billed.`,
        );
      }
      onLog(`credential ${name} (${cred.length} chars, "${cred.slice(0, 11)}…")`);
    }

    if (!cred) {
      throw new Error(
        `the claude CLI has no headless credential, so every cell would die at zero output tokens.\n\n` +
        `  Run one of:\n` +
        `    claude setup-token   then export CLAUDE_CODE_OAUTH_TOKEN=...\n` +
        `    export ANTHROPIC_API_KEY=...\n` +
        `    export ANTHROPIC_AUTH_TOKEN=...  (with ANTHROPIC_BASE_URL for a gateway)\n\n` +
        `  Desktop agent-mode auth is held in-process and the CLI cannot see it.\n` +
        `  A credential is also what lets each cell run under an isolated HOME, which is\n` +
        `  what keeps your own CLAUDE.md and skills out of the control arm.\n` +
        `  Nothing was run and nothing was billed.`,
      );
    }
  }
}

// Did this cell actually execute, or did it fail before the model did any work?
//
// A cell that never ran is not a cell that failed — collapsing those is what made
// the original suite uninterpretable. The CLI exits 0 even when it reports an auth
// error in its own output, so the exit status alone says nothing.
function cellRan(log) {
  let sawResult = false;
  for (const line of log.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "result") continue;
    sawResult = true;
    if (rec.is_error) {
      return { ran: false, error: String(rec.result || rec.terminal_reason || "executor error").slice(0, 200) };
    }
  }
  // No result record at all means the process died before finishing — a timeout or
  // a crash. Also not a failure of the configuration under test.
  return sawResult ? { ran: true, error: null } : { ran: false, error: "no result record — the executor did not finish" };
}

// ------------------------------------------------------------------- cells

function materialise({ spec, task, arm, dest }) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, ".blackbox"), { recursive: true });

  if (task.seed) {
    const seed = resolve(spec.dir, task.seed);
    if (!existsSync(seed)) throw new Error(`task ${task.id}: seed not found at ${seed}`);
    cpSync(seed, dest, { recursive: true });
  }

  // An arm is the set of files installed on top of the seed. `bare` installs nothing;
  // your configured arm installs whatever you actually ship to your team.
  for (const rel of spec.arms[arm].install || []) {
    const src = resolve(spec.dir, rel);
    if (!existsSync(src)) throw new Error(`arm ${arm}: install path not found: ${src}`);
    cpSync(src, join(dest, rel.replace(/^.*\//, "")), { recursive: true });
  }

  const mcp = spec.arms[arm].mcpConfig;
  if (mcp) {
    // Outside the worktree on purpose: anything under dest can be read off disk, and
    // then the run no longer measures whether the server was actually used.
    const path = `${dest}.mcp.json`;
    writeFileSync(path, typeof mcp === "string" ? readFileSync(resolve(spec.dir, mcp), "utf8") : JSON.stringify(mcp));
    return path;
  }
  return null;
}

function verifyCell(task, dest, specDir) {
  const r = spawnSync("bash", ["-lc", task.verify], {
    cwd: dest,
    encoding: "utf8",
    timeout: 300000,
    // The answer key must not sit in the worktree while the model is running — that
    // is contamination route 1. So the verify command copies it in at verify time,
    // and needs to know where it lives.
    env: { ...process.env, BLACKBOX_SPEC_DIR: specDir },
  });
  return {
    passed: r.status === 0,
    output: `${r.stdout || ""}${r.stderr || ""}`.slice(-4000),
  };
}

// Cost and tokens come from the cell's own isolated transcript, reduced by the same
// code path as `blackbox record`. Not self-reported by the model, and not a second
// implementation that can drift from the everyday one.
function meterCell(home) {
  const dir = join(home, ".claude", "projects");
  const files = claudeTranscripts(null, dir);
  const pricing = loadPricing();
  const seen = new Set();
  const events = files.flatMap((f) => reduceClaude(f, seen, pricing));
  const s = summarise(events);
  return {
    turns: s.turns,
    tokens: s.tokens,
    cost_usd: s.priced ? Math.round(s.cost_usd * 1e4) / 1e4 : null,
    tools: Object.fromEntries(s.tools),
    write_batches: s.writes,
  };
}

export function runCell({ spec, task, arm, rep, onLog = () => {} }) {
  const dest = runDir(spec.runsDir, task.id, arm, String(rep));
  const home = `${dest}.home`;

  // Order matters. Purge first so nothing from a previous cell is readable, then
  // prove no answer is reachable, then prove nothing above the worktree configures
  // an agent. All three run before a single token is billed.
  purgeWorktrees(spec.runsDir);
  assertNoStaleAnswers({
    answerNames: task.answerNames || [],
    contentKeys: task.contentKeys || [],
    runsRoot: spec.runsDir,
  });
  mkdirSync(dirname(dest), { recursive: true });
  assertIsolated(dest);

  const mcpConfig = materialise({ spec, task, arm, dest });
  mkdirSync(home, { recursive: true });

  const prompt = task.promptFile
    ? readFileSync(resolve(spec.dir, task.promptFile), "utf8")
    : task.prompt;
  if (!prompt) throw new Error(`task ${task.id}: needs prompt or promptFile`);

  const build = EXECUTORS[spec.executor];
  if (!build) throw new Error(`unknown executor: ${spec.executor}`);
  const { cmd, args, opts } = build({
    dest, prompt, home, mcpConfig,
    model: spec.model,
    timeoutSec: spec.timeoutSec,
  });

  // The exact invocation, recorded. "This arm ran without its MCP server" is
  // otherwise indistinguishable from "this arm chose not to call it", and one of
  // those is a finding while the other is a bug.
  writeFileSync(join(dest, ".blackbox", "cmd.txt"), `${cmd} ${args.join(" ")}\n`);

  const started = Date.now();
  const r = spawnSync(cmd, args, { ...opts, encoding: "utf8", input: "" });
  const log = `${r.stdout || ""}${r.stderr || ""}`;
  writeFileSync(join(dest, ".blackbox", "session.log"), log);
  onLog(`ran ${task.id}/${arm}/${rep} in ${Math.round((Date.now() - started) / 1000)}s`);

  // A cell that never ran is not a cell that failed. Keeping these apart is the
  // distinction that made the original suite interpretable at all — and the CLI
  // exits 0 while reporting an auth error in its own output, so the exit status
  // alone would call a dead cell a legitimate failure.
  const outcome = spec.executor === "stub"
    ? { ran: r.status === 0 && !r.error, error: r.error ? String(r.error.message) : null }
    : cellRan(log);

  const verify = outcome.ran ? verifyCell(task, dest, spec.dir) : { passed: false, output: null };
  const leak = classify(log, dest);
  const meter = spec.executor === "claude" && outcome.ran ? meterCell(home) : {};

  return {
    task: task.id,
    arm,
    rep,
    ran: outcome.ran,
    error: outcome.error,
    passed: verify.passed,
    // A contaminated cell is not a pass and not a fail — it is void, and averaging it
    // into either is how a suite reports a number it did not measure.
    void: leak.reads.length > 0,
    leak_reads: leak.reads.slice(0, 5),
    leak_lists: leak.lists.slice(0, 5),
    wall_clock_s: Math.round((Date.now() - started) / 1000),
    verify_output: verify.passed ? null : verify.output,
    ...meter,
    ts: new Date().toISOString(),
  };
}

export function runSuite({ spec, filter = {}, onLog = () => {} }) {
  // Once, before any cell. A missing credential is not a per-cell condition, and
  // discovering it one cell at a time is how twenty dead runs get billed.
  preflight(spec, onLog);
  const results = [];
  for (const task of spec.tasks) {
    if (filter.task && task.id !== filter.task) continue;
    for (const arm of Object.keys(spec.arms)) {
      if (filter.arm && arm !== filter.arm) continue;
      for (let rep = 1; rep <= spec.reps; rep++) {
        try {
          results.push(runCell({ spec, task, arm, rep, onLog }));
        } catch (e) {
          // A guard refusing to start is a result worth recording, not a crash. It
          // means nothing was billed, which is the whole point of running it first.
          results.push({
            task: task.id, arm, rep, ran: false, passed: false, void: false,
            blocked: e.message, ts: new Date().toISOString(),
          });
          onLog(`blocked ${task.id}/${arm}/${rep}: ${e.message.split("\n")[0]}`);
        }
      }
    }
  }
  return results;
}

// -------------------------------------------------------------------- score

export function score(results) {
  const arms = {};
  for (const r of results) {
    const a = (arms[r.arm] ??= {
      cells: 0, ran: 0, passed: 0, void: 0, blocked: 0, dead: 0,
      cost_usd: 0, priced: false, wall_clock_s: 0,
    });
    a.cells++;
    if (r.blocked) a.blocked++;
    else if (!r.ran) a.dead++; // started, but the executor never did any work
    if (r.ran) a.ran++;
    if (r.void) a.void++;
    // Void cells are excluded from the pass rate rather than counted as failures.
    if (r.passed && !r.void) a.passed++;
    if (r.cost_usd != null) {
      a.cost_usd += r.cost_usd;
      a.priced = true;
    }
    a.wall_clock_s += r.wall_clock_s || 0;
  }
  for (const a of Object.values(arms)) {
    // Only cells that ran, finished, and were not contaminated can carry a verdict.
    // A rate computed over dead cells is a measurement of your credentials.
    const scored = a.cells - a.void - a.blocked - a.dead;
    a.scored = scored;
    a.pass_rate = scored > 0 ? Math.round((a.passed / scored) * 100) / 100 : null;
    a.cost_usd = a.priced ? Math.round(a.cost_usd * 1e4) / 1e4 : null;
  }
  return arms;
}

export function formatScore(arms) {
  const names = Object.keys(arms);
  const w = Math.max(4, ...names.map((n) => n.length));
  const lines = [
    `${"arm".padEnd(w)}  scored  passed  rate    void  dead  blocked  cost      wall`,
  ];
  for (const [name, a] of Object.entries(arms)) {
    lines.push(
      `${name.padEnd(w)}  ${String(a.scored).padStart(6)}  ${String(a.passed).padStart(6)}  ` +
      `${(a.pass_rate == null ? "  —  " : a.pass_rate.toFixed(2)).padStart(5)}  ` +
      `${String(a.void).padStart(4)}  ${String(a.dead).padStart(4)}  ${String(a.blocked).padStart(7)}  ` +
      `${(a.cost_usd == null ? "—" : "$" + a.cost_usd.toFixed(2)).padStart(8)}  ${a.wall_clock_s}s`,
    );
  }
  const sum = (k) => Object.values(arms).reduce((n, a) => n + a[k], 0);
  if (sum("void")) {
    lines.push("");
    lines.push(`${sum("void")} cell(s) voided by the leak detector and excluded from the rates above.`);
    lines.push("A contaminated cell measured the answer key, not the configuration.");
  }
  if (sum("dead")) {
    lines.push("");
    lines.push(`${sum("dead")} cell(s) never ran — the executor errored before doing any work.`);
    lines.push("Excluded from the rates: a dead cell measures your credentials, not your config.");
  }
  return lines.join("\n");
}
