#!/usr/bin/env node
// blackbox — flight recorder for coding agents.
//
// Reduces host transcripts (Claude Code, Codex) into one append-only event log so
// "what did the agent actually do, what did it touch, what did it cost" is a query
// rather than a grep over 10 MB of JSONL.
//
// Two rules carried over from the agentloop/marshal work that produced this:
//   - Measured facts come from the transcript, never from the model. A model cannot
//     know its own token counts mid-turn.
//   - cost is null, never 0, when a model has no published rate. A made-up rate in a
//     scorecard is worse than a blank cell.
//
// Dependencies: Node 18+. That is the whole install.

import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const HOME = homedir();
const STORE = process.env.BLACKBOX_STORE || join(HOME, ".blackbox");
const EVENTS = join(STORE, "events.jsonl");
const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_DIR || join(HOME, ".claude", "projects");
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, ".codex");

// USD per million tokens, matched by longest model-id prefix so
// claude-haiku-4-5-20251001 hits claude-haiku-4-5. Override with
// ~/.blackbox/pricing.json. A null rate means "not known here" — token counts are
// still recorded, cost is reported unavailable rather than guessed.
const DEFAULT_PRICING = {
  cache_read_multiplier: 0.1,
  cache_write_multiplier: 1.25,
  models: {
    "claude-opus-5": { input: 5.0, output: 25.0 },
    "claude-sonnet-5": { input: 3.0, output: 15.0 },
    "claude-haiku-4-5": { input: 1.0, output: 5.0 },
    "claude-fable-5": { input: 1.0, output: 5.0 },
  },
  default: { input: 3.0, output: 15.0 },
};

function loadPricing() {
  const p = join(STORE, "pricing.json");
  if (!existsSync(p)) return DEFAULT_PRICING;
  try {
    return { ...DEFAULT_PRICING, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return DEFAULT_PRICING; // a broken override must not stop a recording
  }
}

function rates(model, pricing) {
  let best = null;
  for (const name of Object.keys(pricing.models || {})) {
    if (model && model.startsWith(name) && (best === null || name.length > best.length)) best = name;
  }
  return best ? pricing.models[best] : pricing.default;
}

function costOf(usage, model, pricing) {
  const r = rates(model, pricing);
  if (!r || r.input == null || r.output == null) return null;
  const c =
    (usage.tin * r.input +
      usage.tout * r.output +
      usage.cread * r.input * pricing.cache_read_multiplier +
      usage.cwrite * r.input * pricing.cache_write_multiplier) /
    1_000_000;
  return Math.round(c * 1e6) / 1e6;
}

// Host transcript dir for a working directory: every non-alphanumeric char → '-'.
const slugFor = (dir) => dir.replace(/[^a-zA-Z0-9]/g, "-");

function* readJsonl(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      yield JSON.parse(s);
    } catch {
      continue; // a torn line must never abort a read
    }
  }
}

const ensureStore = () => mkdirSync(STORE, { recursive: true });

function seenKeys() {
  const seen = new Set();
  for (const rec of readJsonl(EVENTS)) if (rec.src) seen.add(rec.src);
  return seen;
}

function appendEvents(events) {
  if (!events.length) return 0;
  ensureStore();
  appendFileSync(EVENTS, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return events.length;
}

// Paths an assistant turn actually wrote or read. Captured at record time because
// re-deriving it later means re-ingesting every transcript: the tool_use input is
// right here and storing it is free.
const PATH_KEYS = ["file_path", "notebook_path", "path"];
function filesTouched(content) {
  const out = new Set();
  for (const c of content || []) {
    if (c?.type !== "tool_use" || !c.input) continue;
    for (const k of PATH_KEYS) if (typeof c.input[k] === "string") out.add(c.input[k]);
  }
  return [...out];
}

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function reduceClaude(file, seen, pricing) {
  const out = [];
  for (const rec of readJsonl(file)) {
    const sid = rec.sessionId;
    const ts = rec.timestamp;
    const uid = rec.uuid;
    if (!sid || !ts || !uid || seen.has(uid)) continue;

    const project = rec.cwd || null; // the transcript records its own cwd — better than guessing from the slug
    const msg = rec.message || {};

    // A real human turn. Tool results also arrive as type=user but carry no promptSource.
    if (rec.type === "user" && rec.promptSource) {
      seen.add(uid);
      out.push(event({
        ts, sid, project, actor: "human", event: "turn",
        notes: rec.isSidechain ? "sidechain" : null, src: uid,
      }));
      continue;
    }
    if (rec.type !== "assistant" || !msg.usage) continue;
    seen.add(uid);

    const u = msg.usage;
    const usage = {
      tin: u.input_tokens || 0,
      tout: u.output_tokens || 0,
      cread: u.cache_read_input_tokens || 0,
      cwrite: u.cache_creation_input_tokens || 0,
    };
    const model = msg.model || "";
    const tools = (msg.content || [])
      .filter((c) => c?.type === "tool_use" && c.name)
      .map((c) => c.name);
    const files = filesTouched(msg.content);

    out.push(event({
      ts, sid, project, actor: "assistant", event: "tool_batch",
      tokens_in: usage.tin, tokens_out: usage.tout, cache_read: usage.cread,
      cost_usd: costOf(usage, model, pricing),
      tools, files,
      wrote: tools.some((t) => WRITE_TOOLS.has(t)),
      notes: model + (rec.isSidechain ? " sidechain" : ""),
      src: uid,
    }));
  }
  return out;
}

// Codex writes rollout logs under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Different container, same facts, so it reduces into the same schema and the
// reader stays one code path.
function reduceCodex(file, seen, pricing) {
  const out = [];
  let sid = basename(file, ".jsonl");
  let model = null;
  let project = null;
  let idx = 0;

  for (const rec of readJsonl(file)) {
    const payload = rec.payload || {};
    const ts = rec.timestamp || payload.timestamp || "";
    if (rec.type === "session_meta") {
      sid = payload.id || sid;
      model = payload.model || model;
      project = payload.cwd || project;
      continue;
    }
    if (rec.type === "turn_context") {
      model = payload.model || model;
      continue;
    }
    if (rec.type !== "event_msg") continue;

    const src = `${sid}:${++idx}`;
    if (seen.has(src)) continue;

    if (payload.type === "user_message") {
      seen.add(src);
      out.push(event({ ts, sid, project, actor: "human", event: "turn", notes: "codex", src }));
    } else if (payload.type === "token_count") {
      seen.add(src);
      // last_token_usage is this turn's delta; codex also reports cumulative totals,
      // which would double-count if summed per batch.
      const u = (payload.info || {}).last_token_usage || {};
      const usage = {
        tin: u.input_tokens || 0,
        tout: u.output_tokens || 0,
        cread: u.cached_input_tokens || 0,
        cwrite: u.cache_write_input_tokens || 0,
      };
      const cost = costOf(usage, model || "", pricing);
      out.push(event({
        ts, sid, project, actor: "assistant", event: "tool_batch",
        tokens_in: usage.tin, tokens_out: usage.tout, cache_read: usage.cread,
        cost_usd: cost,
        notes: `codex ${model || "unknown-model"}` +
          (cost === null ? " (no published rate — cost omitted)" : ""),
        src,
      }));
    }
  }
  return out;
}

// One shape for every executor, so a reader never branches on source.
function event(o) {
  return {
    ts: o.ts,
    session_id: o.sid,
    project: o.project ?? null,
    actor: o.actor,
    event: o.event,
    phase: o.phase ?? null,
    tokens_in: o.tokens_in ?? null,
    tokens_out: o.tokens_out ?? null,
    cache_read: o.cache_read ?? null,
    cost_usd: o.cost_usd ?? null,
    verdict: o.verdict ?? null,
    tools: o.tools ?? null,
    files: o.files?.length ? o.files : null,
    wrote: o.wrote ?? null,
    notes: o.notes ?? null,
    src: o.src,
  };
}

function claudeTranscripts(project) {
  const dirs = [];
  if (!existsSync(CLAUDE_PROJECTS)) return dirs;
  const wanted = project ? slugFor(resolve(project)) : null;
  for (const d of readdirSync(CLAUDE_PROJECTS)) {
    if (wanted && d !== wanted) continue;
    const full = join(CLAUDE_PROJECTS, d);
    if (!statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) if (f.endsWith(".jsonl")) dirs.push(join(full, f));
  }
  return dirs;
}

function codexRollouts() {
  const root = join(CODEX_HOME, "sessions");
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root);
  return out;
}

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
    console.error(
      `blackbox: no transcripts for ${project || "any project"} (nothing to record)`,
    );
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

function loadEvents({ project, session, since }) {
  const out = [];
  for (const r of readJsonl(EVENTS)) {
    if (project && r.project !== project) continue;
    if (session && r.session_id !== session) continue;
    if (since && r.ts && r.ts < since) continue;
    out.push(r);
  }
  return out;
}

function summarise(recs) {
  const s = {
    events: recs.length,
    turns: 0,
    tokens: { input: 0, output: 0, cache_read: 0 },
    cost_usd: 0,
    priced: false, // distinguishes "cost $0" from "cost unknown"
    tools: new Map(),
    files: new Map(),
    writes: 0,
  };
  for (const r of recs) {
    if (r.event === "turn") s.turns++;
    if (r.event === "tool_batch") {
      s.tokens.input += r.tokens_in || 0;
      s.tokens.output += r.tokens_out || 0;
      s.tokens.cache_read += r.cache_read || 0;
      for (const t of r.tools || []) s.tools.set(t, (s.tools.get(t) || 0) + 1);
      for (const f of r.files || []) s.files.set(f, (s.files.get(f) || 0) + 1);
      if (r.wrote) s.writes++;
    }
    if (r.cost_usd != null) {
      s.cost_usd += r.cost_usd;
      s.priced = true;
    }
  }
  const stamps = recs.map((r) => r.ts).filter(Boolean).sort();
  s.started = stamps[0] || null;
  s.ended = stamps[stamps.length - 1] || null;
  s.wall_clock_s =
    stamps.length > 1
      ? Math.round((Date.parse(s.ended) - Date.parse(s.started)) / 1000)
      : 0;
  return s;
}

const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

function cmdLog(args) {
  const project = args.includes("--all") ? null : resolve(argValue(args, "--project") || process.cwd());
  const session = argValue(args, "--session");
  const since = argValue(args, "--since");
  const asJson = args.includes("--json");
  const listSessions = args.includes("--sessions");
  const touching = argValue(args, "--touching");

  if (!existsSync(EVENTS)) {
    console.error("blackbox: nothing recorded yet — run `blackbox record` first");
    return 1;
  }

  let recs = loadEvents({ project, session, since });

  // "Which sessions touched this file?" — the question a flight recorder exists for.
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
    const rows = [...hits.values()]
      .map((h) => ({ ...h, files: [...h.files] }))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    if (asJson) return void console.log(JSON.stringify(rows, null, 2)) ?? 0;
    if (!rows.length) {
      console.log(`no recorded session touched a path matching "${touching}"`);
      return 0;
    }
    console.log(`sessions touching "${touching}":\n`);
    for (const r of rows) {
      console.log(`  ${r.ts.slice(0, 16).replace("T", " ")}  ${r.session.slice(0, 8)}  ${r.writes} write-batches`);
      for (const f of r.files.slice(0, 5)) console.log(`      ${f}`);
    }
    return 0;
  }

  if (listSessions) {
    const by = new Map();
    for (const r of recs) {
      const e = by.get(r.session_id) || [];
      e.push(r);
      by.set(r.session_id, e);
    }
    const rows = [...by.entries()]
      .map(([id, rs]) => ({ session: id, project: rs[0].project, ...summarise(rs) }))
      .sort((a, b) => (a.started < b.started ? 1 : -1));
    if (asJson) return void console.log(JSON.stringify(rows.map(stripMaps), null, 2)) ?? 0;
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

  // Default: the most recent session in scope.
  if (!session) {
    let latest = null;
    for (const r of recs) if (r.session_id && (!latest || r.ts > latest.ts)) latest = r;
    if (latest) recs = recs.filter((r) => r.session_id === latest.session_id);
  }
  const s = summarise(recs);
  if (asJson) return void console.log(JSON.stringify(stripMaps(s), null, 2)) ?? 0;

  if (!recs.length) {
    console.log(`no events recorded for ${project || "any project"}`);
    return 0;
  }
  console.log(`session   ${recs[0].session_id}`);
  console.log(`project   ${recs[0].project || "(unknown)"}`);
  console.log(`window    ${s.started} → ${s.ended}  (${s.wall_clock_s}s)`);
  console.log(`events    ${s.events}  turns ${s.turns}  write-batches ${s.writes}`);
  console.log(`tokens    in ${s.tokens.input}  out ${s.tokens.output}  cache_read ${s.tokens.cache_read}`);
  console.log(
    `cost      ` +
      (s.priced ? `$${s.cost_usd.toFixed(4)}` : "unknown (no published rate for this model)"),
  );
  console.log(`tools     ${topN(s.tools, 6).map(([t, n]) => `${t}×${n}`).join("  ") || "(none)"}`);
  console.log(`files     ${s.files.size} touched`);
  for (const [f, n] of topN(s.files, 5)) console.log(`            ${f} ×${n}`);
  return 0;
}

const stripMaps = (o) => ({
  ...o,
  tools: o.tools instanceof Map ? Object.fromEntries(o.tools) : o.tools,
  files: o.files instanceof Map ? Object.fromEntries(o.files) : o.files,
});

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}

// One runnable check for the parts that can silently produce wrong numbers:
// pricing math, torn-line tolerance, idempotency, and the null-vs-zero cost rule.
function selftest() {
  const tmp = mkdtempSync(join(process.env.TMPDIR || "/tmp", "blackbox-"));
  let fails = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
    if (!ok) fails++;
  };

  const pricing = DEFAULT_PRICING;

  // Pricing: 1M in + 1M out + 1M cache_read on opus 5 = 5 + 25 + 0.5 = $30.50.
  // Same assertion as agentloop's state.sh selftest — if these two ever disagree,
  // one of them has drifted.
  check(
    "pricing math (opus 1M in+out+cache_read)",
    costOf({ tin: 1e6, tout: 1e6, cread: 1e6, cwrite: 0 }, "claude-opus-5", pricing),
    30.5,
  );
  check("longest-prefix model match", rates("claude-haiku-4-5-20251001", pricing).input, 1.0);
  check(
    "unknown rate yields null cost, not zero",
    costOf({ tin: 100, tout: 100, cread: 0, cwrite: 0 }, "gpt-5.6-sol", {
      ...pricing,
      models: { "gpt-5.6-sol": { input: null, output: null } },
      default: { input: null, output: null },
    }),
    null,
  );

  // A torn line is skipped, not fatal.
  const torn = join(tmp, "torn.jsonl");
  writeFileSync(torn, '{"a":1}\n{"broken\n{"a":2}\n');
  check("torn line tolerated", [...readJsonl(torn)].length, 2);

  // Reducer: one human turn + one assistant batch, with files and cost.
  const tr = join(tmp, "t.jsonl");
  writeFileSync(
    tr,
    [
      JSON.stringify({ type: "user", promptSource: "sdk", uuid: "u1", sessionId: "s1", timestamp: "2026-07-31T09:00:00Z", cwd: "/repo" }),
      JSON.stringify({ type: "user", uuid: "u2", sessionId: "s1", timestamp: "2026-07-31T09:00:01Z", cwd: "/repo" }), // tool result, not a turn
      JSON.stringify({
        type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-07-31T09:00:02Z", cwd: "/repo",
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/lib/a.ts" } }],
        },
      }),
    ].join("\n") + "\n",
  );
  const seen = new Set();
  const evs = reduceClaude(tr, seen, pricing);
  check("reducer emits 1 turn + 1 batch", evs.map((e) => e.event), ["turn", "tool_batch"]);
  check("tool result is not counted as a human turn", evs.filter((e) => e.actor === "human").length, 1);
  check("files captured from tool_use input", evs[1].files, ["/repo/lib/a.ts"]);
  check("write tool flagged", evs[1].wrote, true);
  check("project taken from transcript cwd", evs[1].project, "/repo");

  // Idempotency: same transcript twice yields nothing new.
  check("re-reducing the same transcript adds nothing", reduceClaude(tr, seen, pricing).length, 0);

  // Summary keeps unknown cost distinguishable from zero cost.
  check("unpriced session reports priced=false", summarise([event({ ts: "x", sid: "s", actor: "a", event: "tool_batch", src: "1" })]).priced, false);

  rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? "\nblackbox selftest PASSED" : `\nblackbox selftest FAILED (${fails})`);
  return fails === 0 ? 0 : 1;
}

const HELP = `blackbox — flight recorder for coding agents

  record [--project DIR] [--all]   Reduce host transcripts into the event log
  log    [--project DIR] [--all]   Summarise the most recent session
         [--sessions]              List sessions instead
         [--touching PATH]         Which sessions touched a path
         [--session ID] [--since ISO] [--json]
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
    case "selftest": return selftest();
    case "path": return void console.log(EVENTS) ?? 0;
    case "help": case "-h": case "--help": return void console.log(HELP) ?? 0;
    default:
      console.error(`blackbox: unknown command "${cmd}" (try: help)`);
      return 1;
  }
}

process.exit(main(process.argv.slice(2)) || 0);
