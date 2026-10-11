#!/bin/sh
# Read one GitHub token line from stdin. Run inside the deployed container so
# database and R2 credentials stay on the host and never enter Actions logs.
set -eu
cd "${KOINOTE_DEPLOY_DIR:-/opt/koinote}"
exec docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T backend sh -c '
  set -eu
  IFS= read -r GITHUB_TOKEN
  test -n "$GITHUB_TOKEN"
  export GITHUB_TOKEN
  exec /app/koinote-repository-sync "$@"
' sync-system-agent-repositories "$@"
