#!/bin/sh
# Trusted operator configuration only. Do not expose this unrestricted wrapper
# to untrusted SSH users without a forced-command allowlist.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: run-container.sh mcp|bridge PROJECT_KEY' >&2
  exit 64
fi
mode=$1
project=$2
case "$project" in
  ''|*[!a-z0-9-]*|-*) echo 'Invalid project key' >&2; exit 64 ;;
esac
[ "${#project}" -le 64 ] || exit 64
case "$mode" in
  mcp) program=server.py ;;
  bridge) program=project-memory-bridge.py ;;
  *) exit 64 ;;
esac
# This optional file is executable shell configuration; it must be admin-owned.
if [ -f /etc/tencent-memory/runner.env ]; then
  . /etc/tencent-memory/runner.env
fi
adapter_root=${TENCENT_MEMORY_ROOT:-/opt/tencent-agent-memory}
network=${TENCENT_MEMORY_NETWORK:-tdai-memory-stack}
image=${TENCENT_MEMORY_IMAGE:-python:3.11-slim-bookworm}
config="$adapter_root/config/$project.json"
state="$adapter_root/state/$project"
[ -f "$config" ] || { echo 'Project configuration missing' >&2; exit 66; }
[ -d "$state" ] || { echo 'Project state directory missing' >&2; exit 66; }
exec docker run --rm -i --init --network "$network" \
  --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 \
  -e "TENCENT_MEMORY_PROJECT=$project" \
  -e TENCENT_MEMORY_CONFIG_DIR=/config -e TENCENT_MEMORY_STATE_DIR=/state \
  -v "$adapter_root/mcp:/app:ro" \
  -v "$config:/config/$project.json:ro" -v "$state:/state" \
  "$image" python -B "/app/$program" "$project"
