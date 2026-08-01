# What these controls buy you

Plain English, for people who will not read the source. Every row is demonstrable in a
terminal in under a minute — that is the point of writing it this way.

## The six ways agents fail in production

| Failure | What we install | What it means for you |
|---|---|---|
| **Runs forever** | A turn cap wired to an interception point, exiting non-zero on breach | "The agent cannot run past your cap. We show you the log line where it stopped, not a promise that it would." |
| **Burns the budget** | A spend cap checked between units of work | "It stops at $50 whether or not it is finished. You do not learn the number from an invoice." |
| **Stops early and calls it done** | Four separate outcomes: passed, void, dead, blocked | "A run that never started is reported differently from one that ran and failed. You always know which you are looking at." |
| **Acts outside its scope** | Predicates checked against the filesystem, not self-assessed | "Before it proceeds unattended, we count the changed files and read the actual spend. The agent's opinion of itself is not an input." |
| **Forgets what was decided** | Continuity store read before the first edit | "A new session starts knowing what the last one decided, instead of re-deriving it wrong." |
| **Skips the check** | A verify command is mandatory in every task | "Work that cannot be checked by a command is refused. We do not score what we cannot verify." |

## The uncomfortable part

Most agent setups declare all six and enforce none. The controls live in a markdown
file that asks the model to police itself, and the compliance signal is the model
saying it complied. That is self-attestation, not a control.

This is not a claim about other people's work. **We audited our own harness and found
32 lines of enforcement behind 3,711 lines of doctrine — a ratio of 1:116 — and the one
enforcement primitive that existed had zero callers.** It exited correctly, had its own
test, and nothing ever invoked it. It had been written after a run burned 3 hours 24
minutes without starting its task, and then wired to nothing.

The hook file was also malformed — a lowercase event name and a missing nesting level —
so it had never fired on any executor. Every claim that depended on it had been
decorative for the life of the repo.

We publish that because it is the strongest thing we can say about the audit: we ran it
on ourselves first, and it found something.

## How you can check us

```bash
npx @edenbuilds/blackbox audit .
```

Static analysis. Nothing runs, nothing is billed, no credentials needed. It reports each
control as **enforced**, **unclear**, or **absent**, plus the ratio of enforcement code
to doctrine.

It deliberately under-reports. A control is only "enforced" if it sits within twelve
lines of something that actually stops execution; enforcement split across functions
comes back as "unclear" rather than a guess. A false *not enforced* sends you to look. A
false *enforced* tells you not to. Only one of those is recoverable.

## What we do not claim

- **Prose rules are not enforced.** "No destructive operations" has no mechanical test.
  We list those separately and say plainly that the model still owns them.
- **Not every executor can be gated.** Hooks fire on Claude Code. Codex and Warp do not
  read them, so on those the controls are callable but not automatic. We state which
  executor each guarantee applies to.
- **A passing eval is not a guarantee.** It is a measurement on your tasks, with the
  contamination checks shown. We report what was measured and what was excluded.
