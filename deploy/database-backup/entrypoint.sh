#!/bin/sh
set -u

interval=${BACKUP_INTERVAL_SECONDS:-21600}
retry_interval=${BACKUP_RETRY_SECONDS:-900}

case "$interval:$retry_interval" in
  *[!0-9:]*|:*|*:) echo "backup intervals must be positive integers" >&2; exit 1 ;;
esac
if [ "$interval" -le 0 ] || [ "$retry_interval" -le 0 ]; then
  echo "backup intervals must be positive integers" >&2
  exit 1
fi

while :; do
  if /usr/local/bin/koinote-database-backup; then
    delay=$interval
  else
    delay=$retry_interval
  fi
  sleep "$delay" &
  wait $!
done
