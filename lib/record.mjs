// Transcript → events. The data layer behind `blackbox record` and `blackbox log`.
//
// Extracted from bin/blackbox.mjs so the evaluator can reduce a cell's isolated
// transcript with the same code path that reduces your everyday sessions. A second
// copy of this reducer is how per-cell cost and everyday cost start disagreeing.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const HOME = homedir();
export const STORE = process.env.BLACKBOX_STORE || join(HOME, ".blackbox");
export const EVENTS = join(STORE, "events.jsonl");
export const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_DIR || join(HOME, ".claude", "projects");
export const CODEX_HOME = process.env.CODEX_HOME || join(HOME, ".codex");

// USD per million tokens, matched by longest model-id prefix so
// claude-haiku-4-5-20251001 hits claude-haiku-4-5. Override with
// ~/.blackbox/pricing.json. A null rate means "not known here" — token counts are
// still recorded, cost is reported unavailable rather than guessed.
export const DEFAULT_PRICING = {
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

export function loadPricing() {
  const p = join(STORE, "pricing.json");
  if (!existsSync(p)) return DEFAULT_PRICING;
  try {
    return { ...DEFAULT_PRICING, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return DEFAULT_PRICING; // a broken override must not stop a recording
  }
}

export function rates(model, pricing) {
  let best = null;
  for (const name of Object.keys(pricing.models || {})) {
    if (model && model.startsWith(name) && (best === null || name.length > best.length)) best = name;
  }
  return best ? pricing.models[best] : pricing.default;
}

export function costOf(usage, model, pricing) {
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
export const slugFor = (dir) => dir.replace(/[^a-zA-Z0-9]/g, "-");

export function* readJsonl(path) {
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

export const ensureStore = (dir = STORE) => mkdirSync(dir, { recursive: true });

export function seenKeys(eventsFile = EVENTS) {
  const seen = new Set();
  for (const rec of readJsonl(eventsFile)) if (rec.src) seen.add(rec.src);
  return seen;
}

export function appendEvents(events, eventsFile = EVENTS) {
  if (!events.length) return 0;
  ensureStore(join(eventsFile, ".."));
  appendFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return events.length;
}

// Paths an assistant turn actually wrote or read. Captured at record time because
// re-deriving it later means re-ingesting every transcript.
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

// One shape for every executor, so a reader never branches on source.
export function event(o) {
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

export function reduceClaude(file, seen, pricing) {
  const out = [];
  for (const rec of readJsonl(file)) {
    const sid = rec.sessionId;
    const ts = rec.timestamp;
    const uid = rec.uuid;
    if (!sid || !ts || !uid || seen.has(uid)) continue;

    const project = rec.cwd || null; // the transcript records its own cwd
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

    out.push(event({
      ts, sid, project, actor: "assistant", event: "tool_batch",
      tokens_in: usage.tin, tokens_out: usage.tout, cache_read: usage.cread,
      cost_usd: costOf(usage, model, pricing),
      tools, files: filesTouched(msg.content),
      wrote: tools.some((t) => WRITE_TOOLS.has(t)),
      notes: model + (rec.isSidechain ? " sidechain" : ""),
      src: uid,
    }));
  }
  return out;
}

// Codex writes rollout logs under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Different container, same facts, so it reduces into the same schema.
export function reduceCodex(file, seen, pricing) {
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

export function claudeTranscripts(project, root = CLAUDE_PROJECTS) {
  const out = [];
  if (!existsSync(root)) return out;
  const wanted = project ? slugFor(resolve(project)) : null;
  for (const d of readdirSync(root)) {
    if (wanted && d !== wanted) continue;
    const full = join(root, d);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(full)) if (f.endsWith(".jsonl")) out.push(join(full, f));
  }
  return out;
}

export function codexRollouts(home = CODEX_HOME) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(join(home, "sessions"));
  return out;
}

export function loadEvents({ project, session, since, eventsFile = EVENTS } = {}) {
  const out = [];
  for (const r of readJsonl(eventsFile)) {
    if (project && r.project !== project) continue;
    if (session && r.session_id !== session) continue;
    if (since && r.ts && r.ts < since) continue;
    out.push(r);
  }
  return out;
}

export function summarise(recs) {
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
    stamps.length > 1 ? Math.round((Date.parse(s.ended) - Date.parse(s.started)) / 1000) : 0;
  return s;
}
