#!/usr/bin/env bash
#
# Run the TLA+ model checks for the concurrency- and security-critical
# protocols.
#
# Requires Java 11+ and a local copy of tla2tools.jar. Point TLA2TOOLS_JAR at
# it, or let it fall back to the copy used during development:
#
#   TLA2TOOLS_JAR=/path/to/tla2tools.jar formal/run.sh
#
# The script asserts the *documented* outcome of every model:
#   - verified protocols must be error-free;
#   - the refuted counter-designs must still violate their invariant, which is
#     what shows the models are sensitive to the property they check.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
jar="${TLA2TOOLS_JAR:-$HOME/.local/share/teamagents-verify/tla2tools.jar}"

if [[ ! -f "$jar" ]]; then
  echo "tla2tools.jar not found at '$jar'. Download it from" >&2
  echo "https://github.com/tlaplus/tlaplus/releases and set TLA2TOOLS_JAR." >&2
  exit 2
fi

metadir="$(mktemp -d)"
trap 'rm -rf "$metadir"' EXIT

tlc() {
  ( cd "$here" && java -cp "$jar" tlc2.TLC -cleanup -metadir "$metadir" \
      -config "$2.cfg" "$1.tla" 2>&1 )
}

status=0

# expect_pass <spec> : TLC must report no error.
expect_pass() {
  local spec="$1" out
  echo "=== $spec.tla (expected: no error) ==="
  out="$(tlc "$spec" "$spec")"
  echo "$out" | tail -n 3
  if ! grep -q "No error has been found" <<<"$out"; then
    echo "FAIL: $spec.tla did not model-check cleanly" >&2
    status=1
  fi
  echo
}

# expect_violation <spec> <cfg> <invariant> : TLC must refute <invariant>.
expect_violation() {
  local spec="$1" cfg="$2" inv="$3" out
  echo "=== $spec.tla + $cfg.cfg (expected: $inv violated) ==="
  out="$(tlc "$spec" "$cfg")"
  echo "$out" | grep -E "Error: Invariant|states generated" | head -n 2
  if ! grep -q "Invariant $inv is violated" <<<"$out"; then
    echo "FAIL: $spec.tla + $cfg.cfg did not violate $inv as documented" >&2
    status=1
  fi
  echo
}

echo "########## verified protocols ##########"
expect_pass Lock
expect_pass Warmup
expect_pass Jobs
expect_pass Sudo

echo "########## refuted counter-designs ##########"
expect_violation LockHuskRace LockHuskRace MutualExclusion
expect_violation Warmup WarmupNoDedup NoConcurrentTerminals
expect_violation Jobs JobsUnsafe NoUnreadOutputLost
expect_violation Sudo SudoViaMcp Secrecy

if [[ $status -eq 0 ]]; then
  echo "OK: all models match their documented outcome."
else
  echo "Formal verification did not match the documented outcome." >&2
fi
exit $status
