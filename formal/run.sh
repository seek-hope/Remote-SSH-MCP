#!/usr/bin/env bash
#
# Run the TLA+ model checks for the concurrency-critical protocols.
#
# Requires Java 11+ and a local copy of tla2tools.jar. Point TLA2TOOLS_JAR at
# it, or let it fall back to the copy used during development:
#
#   TLA2TOOLS_JAR=/path/to/tla2tools.jar formal/run.sh
#
# The script asserts the *documented* outcome of each model:
#   - Lock.tla          must be error-free;
#   - LockHuskRace.tla  must still violate MutualExclusion (the pre-fix bug).
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

# Model-check one spec; echo its combined output, return TLC's exit status.
check() {
  ( cd "$here" && java -cp "$jar" tlc2.TLC -cleanup -metadir "$metadir" \
      -config "$1.cfg" "$1.tla" 2>&1 )
}

status=0

echo "=== Lock.tla (expected: no error) ==="
lock_out="$(check Lock)"; lock_rc=$?
echo "$lock_out" | tail -n 6
if [[ $lock_rc -ne 0 ]] || ! grep -q "No error has been found" <<<"$lock_out"; then
  echo "FAIL: Lock.tla did not model-check cleanly" >&2
  status=1
fi

echo
echo "=== LockHuskRace.tla (expected: MutualExclusion violated) ==="
race_out="$(check LockHuskRace)"; race_rc=$?
echo "$race_out" | grep -E "Error:|states generated|Finished" | head -n 5
if ! grep -q "Invariant MutualExclusion is violated" <<<"$race_out"; then
  echo "FAIL: the pre-fix model unexpectedly satisfied MutualExclusion" >&2
  status=1
fi

echo
if [[ $status -eq 0 ]]; then
  echo "OK: all models match their documented outcome."
else
  echo "Formal verification did not match the documented outcome." >&2
fi
exit $status
