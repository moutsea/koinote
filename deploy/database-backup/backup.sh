#!/bin/sh
set -eu

state_dir=/var/lib/koinote-backup
certificate=/etc/koinote/database-backup-certificate.pem
backup_temp=""
backup_complete=0

notify_failure() {
  [ -n "${BOT_WEBHOOK:-}" ] || return 0
  [ -n "${BOT_WEBHOOK_SECRET:-}" ] || return 0
  now=$(date +%s)
  last_notification=$(cat "$state_dir/last-failure-notification" 2>/dev/null || echo 0)
  if [ $((now - last_notification)) -lt 21600 ]; then
    return 0
  fi
  key_hex=$(printf '%s\n%s' "$now" "$BOT_WEBHOOK_SECRET" | od -An -tx1 | tr -d ' \n')
  sign=$(printf '' | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key_hex" -binary | base64 | tr -d '\n')
  payload=$(jq -n \
    --argjson timestamp "$now" \
    --arg sign "$sign" \
    --arg text "Koinote 数据库备份失败\n主机: $(hostname)\n时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)\n系统会在稍后自动重试。" \
    '{msg_type:"text", timestamp:$timestamp, sign:$sign, content:{text:$text}}')
  if curl --silent --show-error --fail \
    --connect-timeout 10 --max-time 20 \
    -H 'Content-Type: application/json' \
    --data "$payload" "$BOT_WEBHOOK" >/dev/null; then
    printf '%s\n' "$now" > "$state_dir/last-failure-notification"
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$backup_temp" ] && [ -d "$backup_temp" ]; then
    rm -rf -- "$backup_temp"
  fi
  if [ "$status" -ne 0 ] || [ "$backup_complete" -ne 1 ]; then
    notify_failure || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

for name in POSTGRES_HOST POSTGRES_USER POSTGRES_DB PGPASSWORD BACKEND_INTERNAL_TOKEN WORKER_URL; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "$name is required" >&2
    exit 1
  fi
done
test -s "$certificate"
mkdir -p "$state_dir"

backup_temp=$(mktemp -d /tmp/koinote-database-backup.XXXXXX)
timestamp=$(date -u +%Y-%m-%dT%H00Z)
dump_file="$backup_temp/koinote.dump"
encrypted_file="$backup_temp/koinote-$timestamp.dump.cms"

PGPASSWORD=$PGPASSWORD pg_dump \
  --host "$POSTGRES_HOST" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --compress 9 \
  --no-owner \
  --no-privileges \
  --file "$dump_file"

openssl cms -encrypt \
  -binary \
  -aes-256-gcm \
  -outform DER \
  -in "$dump_file" \
  -out "$encrypted_file" \
  "$certificate"

sha256=$(sha256sum "$encrypted_file" | awk '{print $1}')
size=$(wc -c < "$encrypted_file" | tr -d ' ')
upload_url="${WORKER_URL%/}/api/internal/backups/database/$(basename "$encrypted_file")"
response=$(curl \
  --silent --show-error --fail-with-body \
  --retry 3 --retry-all-errors --retry-delay 5 \
  --connect-timeout 10 --max-time 900 \
  -X PUT \
  -H "X-Koinote-Internal-Token: $BACKEND_INTERNAL_TOKEN" \
  -H "X-Koinote-Backup-Sha256: $sha256" \
  -H "Content-Type: application/pkcs7-mime" \
  -H "Content-Length: $size" \
  --upload-file "$encrypted_file" \
  "$upload_url")

printf '%s\n' "$response" | jq -e \
  --arg sha256 "$sha256" \
  --argjson size "$size" \
  '.sha256 == $sha256 and .size == $size' >/dev/null
date +%s > "$state_dir/last-success"
backup_complete=1
echo "database backup uploaded: $(basename "$encrypted_file") ($size bytes)"
