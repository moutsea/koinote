#!/usr/bin/env bash
set -euo pipefail
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cat >"$dir/step" <<'STEP'
printf '%s\n' "$PRIVATE_MARKER"
printf '%s\n' "$PRIVATE_MARKER" >&2
exit "$PROBE_EXIT"
STEP
export PRIVATE_MARKER="private-$$-$RANDOM"
for code in 0 42; do
  result=0
  PROBE_EXIT=$code bash .github/scripts/private-deploy-step.sh "$dir/step" >"$dir/output" 2>&1 || result=$?
  test "$result" = "$code"
  test ! -s "$dir/output"
done
echo 'Private deployment output and exit status verified'
