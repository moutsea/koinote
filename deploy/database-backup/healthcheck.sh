#!/bin/sh
set -eu

state_file=/var/lib/koinote-backup/last-success
test -s "$state_file"
last_success=$(cat "$state_file")
now=$(date +%s)
interval=${BACKUP_INTERVAL_SECONDS:-21600}
maximum_age=$((interval + 7200))
test "$last_success" -le "$now"
test $((now - last_success)) -le "$maximum_age"
