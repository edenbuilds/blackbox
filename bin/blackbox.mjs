#!/usr/bin/env node
// blackbox — flight recorder and evaluator for coding agents.
//
//   record / log   what did the agent actually do, touch, and cost
//   eval           does your agent configuration actually help
//
// Two rules the whole tool holds to:
//   - Measured facts come from the transcript, never from the model. A model cannot
//     know its own token counts mid-turn.
//   - cost is null, never 0, when a model has no published rate. A made-up rate in a
//     scorecard is worse than a blank cell.
//
// Dependencies: Node 18+. That is the whole install.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  claudeTranscripts, codexRollouts, costOf, EVENTS, event, loadEvents, loadPricing,
  rates, readJsonl, reduceClaude, reduceCodex, seenKeys, appendEvents, STORE, summarise,
} from "../lib/record.mjs";
import * as isolate from "../lib/isolate.mjs";
import * as leakscan from "../lib/leakscan.mjs";
import { formatScore, loadSpec, runSuite, score } from "../lib/eval.mjs";

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}

const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const stripMaps = (o) => ({
  ...o,
  tools: o.tools instanceof Map ? Object.fromEntries(o.tools) : o.tools,
  files: o.files instanceof Map ? Object.fromEntries(o.files) : o.files,
});

// -------------------------------------------------------------------- record

function cmdRecord(args) {
  const all = args.includes("--all");
  const project = all ? null : resolve(argValue(args, "--project") || process.cwd());
  const pricing = loadPricing();
  const seen = seenKeys();

  const files = [
    ...claudeTranscripts(project).map((f) => ["claude", f]),
    ...(all ? codexRollouts().map((f) => ["codex", f]) : []),
  ];
  if (!files.length) {
    console.error(`blackbox: no transcripts for ${project || "any project"} (nothing to record)`);
    return 0;
  }

  let total = 0;
  for (const [kind, f] of files) {
    const events = kind === "claude" ? reduceClaude(f, seen, pricing) : reduceCodex(f, seen, pricing);
    total += appendEvents(events);
  }
  console.log(
    `recorded ${total} new events from ${files.length} transcript${files.length === 1 ? "" : "s"} → ${EVENTS}`,
  );
  return 0;
}

// ----------------------------------------------------------------------- log

function cmdLog(args) {
  const project = args.includes("--all") ? null : resolve(argValue(args, "--project") || process.cwd());
  const session = argValue(args, "--session");
  const since = argValue(args, "--since");
  const asJson = args.includes("--json");
  const touching = argValue(args, "--touching");

  if (!existsSync(EVENTS)) {
    console.error("blackbox: nothing recorded yet — run `blackbox record` first");
    return 1;
  }
  let recs = loadEvents({ project, session, since });

  if (touching) {
    const hits = new Map();
    for (const r of recs) {
      for (const f of r.files || []) {
        if (!f.includes(touching)) continue;
        const e = hits.get(r.session_id) || { session: r.session_id, ts: r.ts, files: new Set(), writes: 0 };
        e.files.add(f);
        if (r.wrote) e.writes++;
        e.ts = e.ts < r.ts ? e.ts : r.ts;
        hits.set(r.session_id, e);
      }
    }
    const rows = [...hits.values()].map((h) => ({ ...h, files: [...h.files] }))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    if (asJson) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    if (!rows.length) { console.log(`no recorded session touched a path matching "${touching}"`); return 0; }
    console.log(`sessions touching "${touching}":\n`);
    for (const r of rows) {
      console.log(`  ${r.ts.slice(0, 16).replace("T", " ")}  ${r.session.slice(0, 8)}  ${r.writes} write-batches`);
      for (const f of r.files.slice(0, 5)) console.log(`      ${f}`);
    }
    return 0;
  }

  if (args.includes("--sessions")) {
    const by = new Map();
    for (const r of recs) {
      const e = by.get(r.session_id) || [];
      e.push(r);
      by.set(r.session_id, e);
    }
    const rows = [...by.entries()]
      .map(([id, rs]) => ({ session: id, project: rs[0].project, ...summarise(rs) }))
      .sort((a, b) => (a.started < b.started ? 1 : -1));
    if (asJson) { console.log(JSON.stringify(rows.map(stripMaps), null, 2)); return 0; }
    console.log(`${rows.length} session${rows.length === 1 ? "" : "s"}\n`);
    for (const r of rows.slice(0, 30)) {
      const cost = r.priced ? `$${r.cost_usd.toFixed(2)}` : "  —  ";
      console.log(
        `  ${(r.started || "").slice(0, 16).replace("T", " ")}  ${r.session.slice(0, 8)}  ` +
        `${String(r.turns).padStart(3)} turns  ${cost.padStart(8)}  ${r.writes} writes`,
      );
    }
    return 0;
  }

  if (!session) {
    let latest = null;
    for (const r of recs) if (r.session_id && (!latest || r.ts > latest.ts)) latest = r;
    if (latest) recs = recs.filter((r) => r.session_id === latest.session_id);
  }
  const s = summarise(recs);
  if (asJson) { console.log(JSON.stringify(stripMaps(s), null, 2)); return 0; }
  if (!recs.length) { console.log(`no events recorded for ${project || "any project"}`); return 0; }

  console.log(`session   ${recs[0].session_id}`);
  console.log(`project   ${recs[0].project || "(unknown)"}`);
  console.log(`window    ${s.started} → ${s.ended}  (${s.wall_clock_s}s)`);
  console.log(`events    ${s.events}  turns ${s.turns}  write-batches ${s.writes}`);
  console.log(`tokens    in ${s.tokens.input}  out ${s.tokens.output}  cache_read ${s.tokens.cache_read}`);
  console.log(`cost      ` + (s.priced ? `$${s.cost_usd.toFixed(4)}` : "unknown (no published rate for this model)"));
  console.log(`tools     ${topN(s.tools, 6).map(([t, n]) => `${t}×${n}`).join("  ") || "(none)"}`);
  console.log(`files     ${s.files.size} touched`);
  for (const [f, n] of topN(s.files, 5)) console.log(`            ${f} ×${n}`);
  return 0;
}

// ---------------------------------------------------------------------- eval

function cmdEval(args) {
  const specPath = argValue(args, "--spec") || "blackbox.eval.json";
  if (!existsSync(specPath)) {
    console.error(`blackbox: no spec at ${specPath} (see \`blackbox eval --example\`)`);
    return 1;
  }
  const spec = loadSpec(specPath);
  const out = argValue(args, "--out") || "blackbox-eval-results.json";

  console.log(
    `${Object.keys(spec.arms).length} arms × ${spec.tasks.length} tasks × ${spec.reps} reps ` +
    `= ${Object.keys(spec.arms).length * spec.tasks.length * spec.reps} cells ` +
    `on ${spec.executor}/${spec.model}\n`,
  );

  const results = runSuite({
    spec,
    filter: { task: argValue(args, "--task"), arm: argValue(args, "--arm") },
    onLog: (m) => console.log("  " + m),
  });

  writeFileSync(out, JSON.stringify({ spec: { ...spec, dir: undefined }, results }, null, 2));
  console.log(`\n${formatScore(score(results))}\n`);
  console.log(`${results.length} cells → ${out}`);
  return 0;
}

const EXAMPLE_SPEC = {
  runsDir: "/tmp/blackbox-eval",
  executor: "claude",
  model: "claude-sonnet-5",
  reps: 3,
  arms: {
    bare: { install: [] },
    configured: { install: ["CLAUDE.md", ".claude"] },
  },
  tasks: [
    {
      id: "example",
      seed: "tasks/example/seed",
      promptFile: "tasks/example/task.md",
      verify: "python3 -m pytest -q verify_tests.py",
      answerNames: ["verify_tests.py"],
      contentKeys: [],
    },
  ],
};

// ------------------------------------------------------------------ selftest

function selftest() {
  const tmp = mkdtempSync(join(process.env.TMPDIR || "/tmp", "blackbox-"));
  let fails = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
    if (!ok) fails++;
  };
  const pricing = loadPricing();

  // Pricing: 1M in + 1M out + 1M cache_read on opus 5 = 5 + 25 + 0.5 = $30.50.
  // Same assertion as agentloop's state.sh selftest — if these two ever disagree,
  // one of them has drifted.
  check("pricing math (opus 1M in+out+cache_read)",
    costOf({ tin: 1e6, tout: 1e6, cread: 1e6, cwrite: 0 }, "claude-opus-5", pricing), 30.5);
  check("longest-prefix model match", rates("claude-haiku-4-5-20251001", pricing).input, 1.0);
  check("unknown rate yields null cost, not zero",
    costOf({ tin: 100, tout: 100, cread: 0, cwrite: 0 }, "gpt-5.6-sol",
      { ...pricing, models: { "gpt-5.6-sol": { input: null, output: null } }, default: { input: null, output: null } }),
    null);

  const torn = join(tmp, "torn.jsonl");
  writeFileSync(torn, '{"a":1}\n{"broken\n{"a":2}\n');
  check("torn line tolerated", [...readJsonl(torn)].length, 2);

  const tr = join(tmp, "t.jsonl");
  writeFileSync(tr, [
    JSON.stringify({ type: "user", promptSource: "sdk", uuid: "u1", sessionId: "s1", timestamp: "2026-07-31T09:00:00Z", cwd: "/repo" }),
    JSON.stringify({ type: "user", uuid: "u2", sessionId: "s1", timestamp: "2026-07-31T09:00:01Z", cwd: "/repo" }),
    JSON.stringify({
      type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-07-31T09:00:02Z", cwd: "/repo",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/lib/a.ts" } }],
      },
    }),
  ].join("\n") + "\n");
  const seen = new Set();
  const evs = reduceClaude(tr, seen, pricing);
  check("reducer emits 1 turn + 1 batch", evs.map((e) => e.event), ["turn", "tool_batch"]);
  check("tool result is not counted as a human turn", evs.filter((e) => e.actor === "human").length, 1);
  check("files captured from tool_use input", evs[1].files, ["/repo/lib/a.ts"]);
  check("write tool flagged", evs[1].wrote, true);
  check("project taken from transcript cwd", evs[1].project, "/repo");
  check("re-reducing the same transcript adds nothing", reduceClaude(tr, seen, pricing).length, 0);
  check("unpriced session reports priced=false",
    summarise([event({ ts: "x", sid: "s", actor: "a", event: "tool_batch", src: "1" })]).priced, false);

  // A void cell must not be counted as a failure, and must not be counted as a pass.
  const scored = score([
    { arm: "bare", passed: true, ran: true, void: false, cost_usd: 1 },
    { arm: "bare", passed: false, ran: true, void: false, cost_usd: 1 },
    { arm: "bare", passed: true, ran: true, void: true, cost_usd: 1 },
    { arm: "cfg", passed: false, ran: false, void: false, blocked: "guard tripped" },
  ]);
  check("void cells excluded from the pass rate", [scored.bare.scored, scored.bare.passed, scored.bare.pass_rate], [2, 1, 0.5]);
  check("blocked cells excluded and counted separately", [scored.cfg.scored, scored.cfg.blocked], [0, 1]);
  check("a fully blocked arm has no rate, not a zero rate", scored.cfg.pass_rate, null);

  rmSync(tmp, { recursive: true, force: true });
  console.log("");

  // The ported suites keep their own counts so a failure names the right file.
  const leak = leakscan.selftest();
  const iso = isolate.selftest();
  console.log("");
  const total = fails + leak + iso;
  console.log(total === 0 ? "blackbox selftest PASSED" : `blackbox selftest FAILED (${fails} here)`);
  return total === 0 ? 0 : 1;
}

const HELP = `blackbox — flight recorder and evaluator for coding agents

  record [--project DIR] [--all]   Reduce host transcripts into the event log
  log    [--project DIR] [--all]   Summarise the most recent session
         [--sessions]              List sessions instead
         [--touching PATH]         Which sessions touched a path
         [--session ID] [--since ISO] [--json]

  eval   [--spec FILE]             Run a paired A/B evaluation of agent configs
         [--task ID] [--arm NAME] [--out FILE]
         --example                 Print a starter spec
  leakscan LOG WORKTREE            Did a session read outside its worktree?

  selftest                         Run the built-in checks
  path                             Print the event log path

Store: ${STORE}  (override with BLACKBOX_STORE)
Events are append-only and derived from transcripts, so the log is reproducible:
delete it and \`blackbox record --all\` rebuilds it.`;

function main(argv) {
  const [cmd = "help", ...args] = argv;
  switch (cmd) {
    case "record": return cmdRecord(args);
    case "log": return cmdLog(args);
    case "eval":
      if (args.includes("--example")) { console.log(JSON.stringify(EXAMPLE_SPEC, null, 2)); return 0; }
      return cmdEval(args);
    case "leakscan": {
      const [log, wt] = args;
      if (!log || !wt) { console.error("usage: blackbox leakscan <session.log> <worktree>"); return 1; }
      const { reads, lists } = leakscan.classify(existsSync(log) ? readFileSync(log, "utf8") : "", wt);
      console.log(JSON.stringify({ void: reads.length > 0, reads, lists }, null, 2));
      return reads.length ? 1 : 0;
    }
    case "selftest": return selftest();
    case "path": console.log(EVENTS); return 0;
    case "help": case "-h": case "--help": console.log(HELP); return 0;
    default:
      console.error(`blackbox: unknown command "${cmd}" (try: help)`);
      return 1;
  }
}

process.exit(main(process.argv.slice(2)) || 0);
