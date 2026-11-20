#!/bin/sh
# 在服务器执行发布命令；失败详情仅保存在管理员可读的目录中。
set +x
set -eu
umask 077

[ "$#" -ge 2 ] || { echo 'Deployment command and label are required' >&2; exit 2; }
label=$1
shift
case "$label" in
  ''|*[!A-Za-z0-9_-]*) echo 'Invalid deployment command label' >&2; exit 2 ;;
esac

log_dir=${KOINOTE_DEPLOY_LOG_DIR:-/var/log/koinote-deploy}
mkdir -p "$log_dir"
chmod 700 "$log_dir"
log_file=$(mktemp "$log_dir/$label.XXXXXX")
if "$@" >"$log_file" 2>&1; then
  rm -f "$log_file"
else
  status=$?
  printf 'Deployment command failed (%s, exit %s); inspect private server logs\n' "$label" "$status" >&2
  exit "$status"
fi
