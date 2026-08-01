#!/usr/bin/env bash
# Run an evaluation against Anthropic directly, minting a credential if needed.
#
# There is no paste step. Every failure this script exists to prevent came from one:
# a token pasted into a zsh prompt string, a token pasted at the shell prompt as a
# command, and a token truncated by a narrow terminal — each of which put a live
# credential somewhere it should not be, and none of which produced a working run.
#
# Usage: ./scripts/eval.sh [spec.json] [extra args...]
set -euo pipefail

cd "$(dirname "$0")/.."
SPEC="${1:-examples/convention/blackbox.eval.json}"
shift || true

# A third-party gateway has its own model names and its own billing, and a lapsed one
# fails as an opaque 4xx. This script is the direct path, so the gateway goes away for
# the life of this process only — your shell config is untouched.
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN

looks_like_token() {
  [[ "$1" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]]
}

TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"

if looks_like_token "${TOKEN:-}"; then
  echo "using the credential already in this shell (${#TOKEN} chars)"
else
  if [[ -n "$TOKEN" ]]; then
    echo "the CLAUDE_CODE_OAUTH_TOKEN in this shell is not a usable token (${#TOKEN} chars) — minting a new one"
  else
    echo "no credential in this shell — minting one"
  fi
  echo "A browser window will open. Complete the login there; nothing needs to be copied."
  echo

  # Captured from stdout and matched by pattern, so surrounding instructions in the
  # CLI's output cannot end up inside the variable. The value is never printed.
  raw="$(claude setup-token || true)"
  TOKEN="$(printf '%s' "$raw" | grep -oE 'sk-ant-[A-Za-z0-9_-]+' | tail -1 || true)"
  unset raw

  if ! looks_like_token "${TOKEN:-}"; then
    echo
    echo "! could not capture a token from \`claude setup-token\`." >&2
    echo "  Some builds print it to the terminal rather than to stdout. If you saw a" >&2
    echo "  token on screen, re-run this script as:" >&2
    echo "      CLAUDE_CODE_OAUTH_TOKEN=\$(pbpaste) ./scripts/eval.sh" >&2
    echo "  after copying it — pbpaste keeps it out of your shell history." >&2
    echo "  Nothing was run and nothing was billed." >&2
    exit 1
  fi
  echo "captured a credential (${#TOKEN} chars)"
fi

echo
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" node bin/blackbox.mjs eval --spec "$SPEC" "$@"
