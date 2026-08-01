<div align="center">

# ⬛ blackbox

**Flight recorder for coding agents.**

Your agent sessions already log every tool call, file write, and token spent.
`blackbox` turns that into something you can actually ask questions of.

[![ci](https://github.com/edenbuilds/blackbox/actions/workflows/ci.yml/badge.svg)](https://github.com/edenbuilds/blackbox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@edenbuilds/blackbox?color=black&label=npm)](https://www.npmjs.com/package/@edenbuilds/blackbox)
[![license](https://img.shields.io/badge/license-MIT-black)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-black)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-black)](./package.json)

</div>

---

```bash
npx @edenbuilds/blackbox record --all
```

```
recorded 37679 new events from 335 transcripts → ~/.blackbox/events.jsonl
```

That data was already on your disk. It was just unaskable.

```bash
blackbox log --touching lib/auth
```

```
sessions touching "lib/auth":

  2026-07-29 02:03  e3126694  3 write-batches
      lib/auth/session.ts
      lib/auth/session.test.ts
  2026-07-27 09:28  2a25f242  11 write-batches
      lib/auth/session.ts
      lib/auth/middleware.ts
```

---

## The problem

Every Claude Code and Codex session writes a complete transcript to your disk. Tool
calls, file paths, token counts, model IDs — all of it, in `~/.claude/projects/**/*.jsonl`.

It is also 10 MB of newline-delimited JSON per session, in a shape no tool reads. So
nobody asks the questions that data would answer, and three things quietly go wrong:

- **Spend is invisible.** You find out what agents cost when the invoice arrives, not
  which project or which session burned it.
- **Changes are unattributable.** `git blame` says the commit. It does not say which
  session wrote it, what else that session touched at the same time, or what it read
  first.
- **Autonomy is unaudited.** The moment an agent runs unattended, "what was it allowed
  to do, and what did it actually do" stops being a rhetorical question — and there is
  no answer anywhere.

`blackbox` reduces those transcripts into one append-only event log and gives you a
query surface over it. Nothing is uploaded. There is no network call in this tool.

## What it's actually for

**"Where is my agent budget going?"**
```bash
blackbox log --sessions
```
```
29 sessions

  2026-07-31 10:51  47056909    1 turns     $1.94  0 writes
  2026-07-30 09:25  de57000c    2 turns    $22.21  14 writes
  2026-07-29 07:41  9e25f750   13 turns   $174.02  86 writes
```
Per-session cost, turns, and how many batches actually wrote something. The session
that cost $174 and wrote 86 times is a different animal from the one that cost $37 and
wrote 6 — and until now you could not tell them apart.

**"Which session broke this file?"**
```bash
blackbox log --touching lib/causelist-pipeline
```
Every session that read or wrote a matching path, newest first, with write counts.
Start here, then go to `git log`. Especially useful when the answer is *"three sessions
touched it and only one of them wrote"*.

**"What did last month cost, across everything?"**
```bash
blackbox log --all --since 2026-07-01 --json
```
Machine-readable totals for tokens, cost, tools, and files. Pipe it into whatever you
already use for reporting.

**"What did the unattended run actually do?"**
```bash
blackbox log --session <id>
```
```
session   a6cf33bb-114a-4ce9-8042-4ce7dad70c49
project   /Users/you/your-repo
window    2026-07-11T11:29:09.459Z → 2026-07-12T01:07:51.604Z  (49122s)
events    1009  turns 10  write-batches 159
tokens    in 2061  out 674735  cache_read 402676588
cost      $167.7468
tools     Bash×181  Edit×82  Write×77  Read×52  Grep×43  Glob×40
files     80 touched
            app/page.tsx ×13
            lib/generate.ts ×10
            app/app/page.tsx ×10
            README.md ×8
            .env ×7
```
A defensible record of an autonomous session: what it ran, what it wrote, what it cost.
Ten human turns produced 159 write-batches across 80 files over fourteen hours — and
one of those files was `.env`, which is exactly the kind of thing you want to find in a
log rather than in an incident.

## Does your agent config actually help?

Everyone is writing CLAUDE.md files, installing skill packs, and adding MCP servers.
Almost nobody has measured whether any of it helps. `blackbox eval` runs the same task
with your config and without it, in isolated worktrees, and compares.

```bash
blackbox eval --example > blackbox.eval.json   # edit, then
blackbox eval
```

```
arm               passed   rate    void  dead  blocked  cost      wall
bare                 0/3   0.00     0     0        0     $0.26   47s
with-conventions     3/3   1.00     0     0        0     $0.34   58s
```

That is a real run, not an illustration. The task needs a naming convention and a
sort-order tie-break that exist only in the `CLAUDE.md` the second arm installs, so
the first arm cannot know them — it wrote a working accessor under the wrong name
every time. Three reps, sixty cents, nothing void, dead, or blocked.

It is also a deliberately favourable case: the convention is genuinely undiscoverable
from the repo. That makes it a clean test of the harness, not evidence that agent
configs help in general — for which you would run *your* tasks, not this one.

An **arm** is just a set of files installed into the worktree, so it works with
whatever you actually ship to your team:

```json
{
  "arms": {
    "bare":       { "install": [] },
    "configured": { "install": ["CLAUDE.md", ".claude"] }
  },
  "tasks": [{
    "id": "add-retry",
    "seed": "tasks/add-retry/seed",
    "promptFile": "tasks/add-retry/task.md",
    "verify": "python3 -m pytest -q verify_tests.py",
    "answerNames": ["verify_tests.py"]
  }]
}
```

### Why you can trust the number

Benchmarking agents is easy to do wrong, and the failure is silent — a contaminated
run looks exactly like a good one. These guards run **before any tokens are billed**:

- **Ancestor check.** Claude Code and Codex both walk parent directories for
  `CLAUDE.md`/`AGENTS.md`. If any exists above the run directory, your "bare" arm
  isn't bare — so the suite refuses to start rather than publish the number.
- **Stale-answer check.** If a copy of the task's answer is reachable in any scratch
  directory, the cell is blocked. A session that finds one passes without using the
  thing under test. This searches by filename *and* by content, because a previous
  session's scratchpad holds what it retrieved in a file no filename rule matches.
- **One worktree at a time.** Siblings are readable. Anonymous directory names don't
  help — `find ..` enumerates them regardless. The only property that holds is that
  there is nothing to find. The agent CLI's own scratchpad, which outlives the
  worktree, is purged too.
- **Leak detection after the fact.** Every session log is scanned for reads outside
  its worktree. A contaminated cell is **void** — not a pass, not a fail — and is
  excluded from the rate rather than averaged into it.
- **Blocked ≠ failed.** A cell that never ran is reported separately from one that
  ran and failed. Collapsing those makes a suite uninterpretable.

Reading is distinguished from listing: `ls` and `find` reveal file *names* and void
nothing; `cat`, `rg`, and `sqlite3` reveal *content* and void the cell.

These aren't hypotheticals. Every one of them exists because a real suite published a
number it shouldn't have — including one where five of six control runs read the
answer key out of their own working directory.

## Install

```bash
npx @edenbuilds/blackbox selftest
```

That is the install. **Node 18+, zero dependencies** — no SDK, no database server, no
daemon, no account.

Or keep it around:

```bash
npm install -g @edenbuilds/blackbox
```

## Use

```bash
blackbox record                     # this project's transcripts
blackbox record --all               # every project, plus Codex rollouts

blackbox log                        # most recent session here
blackbox log --sessions             # one line per session
blackbox log --touching lib/auth    # which sessions touched a path
blackbox log --all --since 2026-07-01 --json

blackbox path                       # where the event log lives
blackbox selftest                   # built-in checks
```

`record` is **idempotent** — it keys on the transcript's own message uuid, so running it
twice adds nothing and running it against a growing transcript adds only what is new.
There is no wrong number of times to run it.

### Record automatically

Add a `SessionEnd` hook in `~/.claude/settings.json` and never think about it again:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "npx -y @edenbuilds/blackbox record --all" }]
      }
    ]
  }
}
```

A cron or a shell alias works just as well. The log is derived, so nothing breaks if you
miss a run — the next `record` picks up everything.

## What it records

One shape per event regardless of executor, so a reader never branches on source:

| field | |
|---|---|
| `ts`, `session_id`, `project` | `project` comes from the transcript's own recorded `cwd`, not a guess from the directory name |
| `actor`, `event` | `human` / `assistant`; `turn` / `tool_batch` |
| `tokens_in`, `tokens_out`, `cache_read` | measured from the transcript, never self-reported |
| `cost_usd` | `null`, never `0`, when the model has no published rate |
| `tools`, `files`, `wrote` | tool names, paths from tool-call inputs, and whether the batch used a write tool |
| `src` | idempotency key — the host's message uuid |

It is plain JSONL at `~/.blackbox/events.jsonl`. `jq` it, load it into DuckDB, do
whatever you want with it — the CLI is a convenience, not a gatekeeper.

## Design rules

These are the rules the tool holds itself to. They exist because each one was, at some
point, the thing that made a number wrong.

- **Measured facts come from the transcript, never from the model.** A model cannot know
  its own token counts mid-turn, so anything it reports about itself is a guess.
- **`cost` is `null`, never `0`, when a rate is unknown.** A made-up rate in a report is
  worse than a blank cell. `log` prints `unknown`, not `$0.00`.
- **The log is derived, so it is reproducible.** Everything comes from transcripts that
  already exist. Delete the log and `record --all` rebuilds it exactly.
- **A torn line is skipped, never fatal.** Transcripts are appended to live; reading one
  mid-write must not abort a recording.
- **Nothing leaves your machine.** No network call, no telemetry, no account. The event
  log is a file on your disk and that is the entire architecture.

## Pricing

Rates are USD per million tokens, matched by longest model-id prefix so
`claude-haiku-4-5-20251001` resolves to `claude-haiku-4-5`. Override by writing
`~/.blackbox/pricing.json`:

```json
{
  "cache_read_multiplier": 0.1,
  "cache_write_multiplier": 1.25,
  "models": { "your-model": { "input": 1.0, "output": 5.0 } },
  "default": { "input": 3.0, "output": 15.0 }
}
```

A model with `null` rates still has its tokens recorded — only the cost is withheld.

## Status

**v0.1.0.** Works, small, honest about its edges.

Verified against **37,705 events reduced from 335 real transcripts**: zero duplicate
idempotency keys, and per-session token and cost totals match an independent recount of
the raw transcripts exactly. `blackbox selftest` covers the pricing math, longest-prefix
model matching, the null-vs-zero cost rule, torn-line tolerance, reducer output shape,
file capture from tool-call inputs, and ingest idempotency.

The evaluator has been run end to end against a live model — isolation, arm install,
execution, verify, leak scan, and cost metering from the cell's own transcript, with
zero cells void, dead, or blocked. That validates the pipeline. It is **not** a claim
that agent configs help: a single rep of a single task is a smoke test, and this repo
would rather ship no number than a number it cannot stand behind.

**Not here yet**, deliberately:

- No SQLite index — the log is read in full, which is fine at 14 MB. When it isn't, that
  is the first thing to add.
- Claude Code and Codex only. Other executors reduce into the same schema; they just
  need a reducer.
- No eval or benchmark mode yet. Recording is the foundation; scoring comes next.
- No hosted anything. This is a local tool and will stay one.

## Prior art

The reducer is ported from the session-state tooling in
[agentloop](https://github.com/edenbuilds/agentloop), where it was validated across
three executors by a paired A/B benchmark suite. The two rules that survived that
process intact — measured facts come from the transcript, and cost is null rather than
zero — are the ones above.

## License

MIT © [edenbuilds](https://github.com/edenbuilds)
