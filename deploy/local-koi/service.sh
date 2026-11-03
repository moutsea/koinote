#!/bin/bash
# launchd starts the managed service only when its expected port is free.
set -eu
cd "$(dirname "$0")"
case "$1" in
  backend)
    if ! docker info >/dev/null 2>&1; then docker desktop start; fi
    # The installer provisions these Compose containers with the real project
    # environment. Starting existing containers needs no copy of its secrets.
    docker start koinote-postgres-1 koinote-backend-1 >/dev/null
    for i in {1..60}; do
      if curl --noproxy '*' -fsS --cacert "$KOI_LOCAL_TLS_DIR/backend.ca.crt" --max-time 2 https://127.0.0.1:18090/health >/dev/null; then exit 0; fi
      sleep 1
    done
    exit 1
    ;;
  vite) port=5273 ;;
  images) port=8788 ;;
  *) exit 2 ;;
esac
if /usr/bin/nc -z 127.0.0.1 "$port" 2>/dev/null || /usr/bin/nc -z ::1 "$port" 2>/dev/null; then
  echo "Koinote Local 无法启动 $1：端口 $port 已被占用。" >&2
  exit 1
fi
if [ "$1" = vite ]; then
  export VITE_DESKTOP_FLAVOR=local
  exec node node_modules/vite/bin/vite.js preview --host localhost --port "$port" --strictPort
fi
export NODE_EXTRA_CA_CERTS="$KOI_LOCAL_TLS_DIR/backend.ca.crt"
exec node node_modules/wrangler/bin/wrangler.js dev --local-protocol https --https-cert-path "$KOI_LOCAL_TLS_DIR/images.crt" --https-key-path "$KOI_LOCAL_TLS_DIR/images.key" --local --persist-to "$KOI_WORKER_STATE" --ip 127.0.0.1 --port "$port"
