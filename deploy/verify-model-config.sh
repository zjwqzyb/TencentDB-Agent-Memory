#!/usr/bin/env bash
# 部署后验收：检查某个实例的「模型配置」状态是否可用、是否与预期一致。
#
# 用法：
#   ./verify-model-config.sh --panel-url http://127.0.0.1:8125 \
#       --instance-id demo --user-key <system_admin 的 user_key>
#
#   # 额外触发一次「重新同步知识服务」（启用后 KS 同步失败时的恢复动作）
#   ./verify-model-config.sh ... --resync
#
#   # 断言当前状态（CI 用）：active / paused / draft / deployment
#   ./verify-model-config.sh ... --expect active
#
# 退出码：
#   0 = 调用成功且状态符合预期
#   1 = 网络/协议失败（Panel 不可达、鉴权失败、信封 code != 0）
#   3 = 状态与 --expect 不符
#
# 依赖：bash、curl、python3（仅用于解析 JSON，不落盘、不打印 Key）

set -euo pipefail

PANEL_URL=""
INSTANCE_ID=""
USER_KEY=""
EXPECT=""
RESYNC=0

usage() { sed -n '2,20p' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel-url) PANEL_URL="${2:-}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
    --user-key) USER_KEY="${2:-}"; shift 2 ;;
    --expect) EXPECT="${2:-}"; shift 2 ;;
    --resync) RESYNC=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$PANEL_URL" || -z "$INSTANCE_ID" || -z "$USER_KEY" ]]; then
  echo "缺少必填参数：--panel-url / --instance-id / --user-key" >&2
  usage >&2
  exit 1
fi

PANEL_URL="${PANEL_URL%/}"

post() {
  local action="$1" body="$2"
  local out
  out="$(mktemp)"
  local code
  code="$(curl -sS --max-time 30 -o "$out" -w '%{http_code}' \
    -X POST "${PANEL_URL}/api/v1/meta/${action}" \
    -H 'content-type: application/json' \
    -H "X-Tdai-Service-Id: ${INSTANCE_ID}" \
    -H "X-Tdai-User-Key: ${USER_KEY}" \
    -d "$body" || echo "000")"
  if [[ "$code" != "200" ]]; then
    echo "FAIL  ${action}: HTTP ${code}" >&2
    # 信封 message 可以安全打印（服务端已脱敏），但绝不打印 Key
    python3 - "$out" <<'PY' 2>/dev/null || true
import json,sys
try:
    env=json.load(open(sys.argv[1]))
    print(f"      code={env.get('code')} message={env.get('message')}", file=sys.stderr)
except Exception:
    pass
PY
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

echo "== 读取模型配置：instance=${INSTANCE_ID} panel=${PANEL_URL}"
CONFIG_JSON="$(post "instance-upstream/extraction/get" '{}')" || exit 1

SUMMARY="$(printf '%s' "$CONFIG_JSON" | python3 -c '
import json,sys
env=json.load(sys.stdin)
if env.get("code") != 0:
    print("ERR|" + str(env.get("message")))
    raise SystemExit(0)
d=env.get("data") or {}
draft=d.get("draft") or {}
active=d.get("active_snapshot") or {}
test=d.get("test") or {}
if d.get("paused"):
    state="paused"
elif d.get("enabled") is True and active:
    state="active"
elif draft:
    state="draft"
elif d.get("configured"):
    state="deployment-active"
else:
    state="deployment"
def s(v):
    v = "-" if v in (None, "") else str(v)
    return v.replace("|", "/").replace("\n", " ")
print("|".join([
    "OK", state,
    s(d.get("source")),
    s(d.get("provider")),
    s(draft.get("model_id") or d.get("model_id")),
    "v"+str(d.get("version", "-")),
    s(active.get("snapshot_id")),
    s(active.get("version") if active else None),
    s(test.get("test_id")),
    "passed" if test.get("passed") else ("none" if not test else "failed"),
    ("matches" if test.get("matches_current") else "stale") if test else "-",
    s(test.get("expires_at")),
]))' )"

if [[ "${SUMMARY%%|*}" == "ERR" ]]; then
  echo "FAIL  读取失败：${SUMMARY#*|}" >&2
  exit 1
fi

IFS='|' read -r _ STATE SOURCE PROVIDER MODEL VERSION SNAP_ID SNAP_VERSION TEST_ID TEST_PASS TEST_MATCH TEST_EXP <<< "$SUMMARY"

echo "  状态        : $STATE"
echo "  来源        : $SOURCE"
echo "  provider    : $PROVIDER"
echo "  model       : $MODEL"
echo "  配置版本    : $VERSION"
echo "  active 快照 : ${SNAP_ID}@${SNAP_VERSION}"
if [[ "$TEST_ID" == "-" ]]; then
  echo "  测试证据    : 无（启用前必须先通过连接测试）"
else
  echo "  测试证据    : ${TEST_ID}（${TEST_PASS}/${TEST_MATCH}，过期 ${TEST_EXP}）"
fi

if [[ "$RESYNC" == "1" ]]; then
  echo "== 触发知识服务重新同步"
  RESYNC_JSON="$(post "instance-upstream/extraction/resync-knowledge" '{}')" || exit 1
  RESYNC_STATUS="$(printf '%s' "$RESYNC_JSON" | python3 -c '
import json,sys
env=json.load(sys.stdin)
if env.get("code") != 0:
    print("ERR\t"+str(env.get("message")))
else:
    d=env.get("data") or {}
    print("OK\t"+str(d.get("status"))+"\t"+str(d.get("config_version")))')"
  if [[ "${RESYNC_STATUS%%|*}" == "ERR" ]]; then
    echo "FAIL  重新同步失败：${RESYNC_STATUS#*|}" >&2
    exit 1
  fi
  echo "  同步结果    : ${RESYNC_STATUS#*|}"
fi

if [[ -n "$EXPECT" && "$EXPECT" != "$STATE" ]]; then
  echo "FAIL  期望状态 '${EXPECT}'，实际 '${STATE}'" >&2
  exit 3
fi

case "$STATE" in
  paused)
    echo "WARN  受管模型当前停用：新作业会 fail-closed（不会回退部署模型）"
    ;;
  active)
    if [[ "$TEST_PASS" != "passed" || "$TEST_MATCH" != "matches" ]]; then
      echo "WARN  active 快照存在，但最近一次测试证据不是 passed/matches —— 请确认是否为预期"
    fi
    ;;
esac

echo "PASS  模型配置可读且状态=${STATE}"
