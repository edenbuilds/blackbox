# blackbox

Flight recorder for coding agents. Reduces Claude Code and Codex transcripts into one
append-only event log, so *what did the agent actually do, what did it touch, and what
did it cost* is a query instead of a grep over 10 MB of JSONL.

```bash
npx @edenbuilds/blackbox record --all
npx @edenbuilds/blackbox log --touching causelist-pipeline
```

```
sessions touching "causelist-pipeline":

  2026-07-29 02:03  e3126694  3 write-batches
      lib/causelist-pipeline.ts
      lib/causelist-pipeline.test.ts
  2026-07-27 09:28  2a25f242  11 write-batches
      lib/causelist-pipeline.ts
      lib/causelist-pipeline.test.ts
```

## Why

Your agent sessions already produce a complete record of every tool call, file write,
and token spent. It is sitting in `~/.claude/projects/**/*.jsonl` in a shape nothing can
query. So nobody asks the obvious questions:

- Which sessions touched this file, and did they write or just read?
- What did last week actually cost, per project?
- Which session introduced this, and what else did it change at the same time?

That gap becomes a real problem the moment more than one person is running agents
against the same repo, and a compliance problem the moment someone asks what an
autonomous session was allowed to do.

## Install

```bash
npx @edenbuilds/blackbox selftest
```

That is the install. Node 18+, no dependencies — no SDK, no database server, no daemon.

## Use

```bash
blackbox record                     # this project's transcripts
blackbox record --all               # every project, plus Codex rollouts

blackbox log                        # most recent session here
blackbox log --sessions             # one line per session
blackbox log --touching lib/auth    # which sessions touched a path
blackbox log --all --since 2026-07-01 --json
```

`record` is idempotent — it keys on the transcript's own message uuid, so running it
twice adds nothing and running it on a growing transcript adds only what is new. Put it
in a `SessionEnd` hook or a cron; there is no wrong number of times to run it.

## What it records

One shape per event regardless of executor, so a reader never branches on source:

| field | |
|---|---|
| `ts`, `session_id`, `project` | `project` comes from the transcript's own recorded `cwd`, not a guess from the directory name |
| `actor`, `event` | `human`/`assistant`; `turn`/`tool_batch` |
| `tokens_in`, `tokens_out`, `cache_read` | measured from the transcript, never self-reported |
| `cost_usd` | `null`, never `0`, when the model has no published rate |
| `tools`, `files`, `wrote` | tool names, paths from tool-call inputs, and whether the batch used a write tool |
| `src` | idempotency key — the host's message uuid |

## Design rules

- **Measured facts come from the transcript, never from the model.** A model cannot know
  its own token counts mid-turn, so anything it reports about itself is a guess.
- **`cost` is `null`, never `0`, when a rate is unknown.** A made-up rate in a scorecard
  is worse than a blank cell. `log` prints `unknown`, not `$0.00`.
- **The log is derived, so it is reproducible.** Everything comes from transcripts that
  already exist. Delete `~/.blackbox/events.jsonl` and `record --all` rebuilds it.
- **A torn line is skipped, never fatal.** Transcripts are appended to live; reading one
  mid-write must not abort a recording.
- **Nothing is sent anywhere.** There is no network call in this tool. The event log is a
  file on your disk.

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

A model with `null` rates still has its tokens recorded; only the cost is withheld.

## Status

v0.1.0. `blackbox selftest` covers the pricing math, longest-prefix model matching, the
null-vs-zero cost rule, torn-line tolerance, reducer output shape, file capture from
tool-call inputs, and ingest idempotency.

Verified against 37,705 events reduced from 335 real transcripts: zero duplicate
idempotency keys, and per-session token and cost totals match an independent recount of
the raw transcripts exactly.

Not here yet: no SQLite index (the log is read in full — fine at ~14 MB, revisit when it
isn't), no eval/benchmark mode, no hosted anything.

## License

MIT
