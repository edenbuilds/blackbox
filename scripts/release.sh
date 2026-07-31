#!/usr/bin/env bash
# Publish blackbox to npm, then prove the published artifact actually works.
#
# npm requires a second factor for publishes once 2FA is on. Two ways to satisfy it:
#
#   NPM_TOKEN   a granular access token with "bypass 2FA" enabled — unattended, for CI
#   OTP         the 6-digit code from your authenticator — interactive, prompted below
#
# Neither is ever written to the repo, passed as an argument, or left in your shell
# history. The token goes into a mode-600 userconfig in a temp dir that is deleted on
# exit; the OTP goes in as an environment variable. Arguments would be visible to any
# other process via `ps`, which is why nothing here takes one.
set -euo pipefail

cd "$(dirname "$0")/.."
PKG=$(node -p "require('./package.json').name")
VER=$(node -p "require('./package.json').version")

TMPHOME=""
cleanup() { [[ -n "$TMPHOME" ]] && rm -rf "$TMPHOME"; }
trap cleanup EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Preflight"

# Never publish something that fails its own checks.
node bin/blackbox.mjs selftest | tail -1

if [[ -n "$(git status --porcelain)" ]]; then
  echo "! working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi
echo "ok   working tree clean"

# A version already on the registry cannot be republished; npm would fail late with
# E403, which reads identically to the 2FA error and sends you chasing the wrong thing.
if npm view "$PKG@$VER" version >/dev/null 2>&1; then
  echo "! $PKG@$VER is already published — bump the version first" >&2
  exit 1
fi
echo "ok   $PKG@$VER is not yet on the registry"

WHO=$(npm whoami 2>/dev/null || true)
[[ -n "$WHO" ]] || { echo "! not logged in — run: npm login" >&2; exit 1; }
echo "ok   logged in as $WHO"

say "Authenticating the publish"

NPM_ARGS=()
if [[ -n "${NPM_TOKEN:-}" ]]; then
  # Token path. Written to a private userconfig rather than ~/.npmrc so a CI runner
  # (or this laptop) never ends up with a long-lived credential in a dotfile.
  TMPHOME=$(mktemp -d)
  umask 077
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$TMPHOME/npmrc"
  NPM_ARGS+=(--userconfig "$TMPHOME/npmrc")
  echo "using NPM_TOKEN (granular access token)"
else
  # Interactive path. -s so the code is not echoed to the terminal or scrollback.
  printf 'npm one-time code (6 digits from your authenticator): '
  read -rs OTP
  printf '\n'
  [[ "$OTP" =~ ^[0-9]{6}$ ]] || { echo "! that is not a 6-digit code — recovery codes and setup keys will not work here" >&2; exit 1; }
  export NPM_CONFIG_OTP="$OTP"   # env, not argv: argv is world-readable via ps
  echo "using one-time code"
fi

say "Publishing $PKG@$VER"
npm publish --access public "${NPM_ARGS[@]+"${NPM_ARGS[@]}"}"

say "Verifying the published artifact"
# The publish output is npm telling you it accepted the upload. It is not evidence the
# thing installs and runs. Fetch it back from the registry, in a clean directory, with
# an empty cache, and make it prove itself.
VERIFY=$(mktemp -d)
(
  cd "$VERIFY"
  npm cache clean --force >/dev/null 2>&1 || true
  npx -y "$PKG@$VER" selftest | tail -1
  npx -y "$PKG@$VER" help | head -1
)
rm -rf "$VERIFY"

say "Done"
echo "  https://www.npmjs.com/package/$PKG"
echo "  npx $PKG record --all"
