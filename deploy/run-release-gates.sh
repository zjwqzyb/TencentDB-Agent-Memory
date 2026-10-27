#!/usr/bin/env bash
# 模型配置特性的发布门禁：四个子项目的测试/构建 + 产物校验。
#
# 用法（仓库根目录执行）：
#   ./deploy/run-release-gates.sh            # 全量
#   SKIP_TESTS=1 ./deploy/run-release-gates.sh   # 只跑构建与产物校验
#
# 检查项：
#   1. MemoryCore   : vitest 全量 + build:plugin
#   2. MemoryProxy  : vitest 全量（无 build 步骤，运行时走 tsx）
#   3. MemoryKnowledge: vitest 全量 + build
#   4. MemoryPanel  : vitest 全量 + tsc(typecheck) + build(tsc) + web build
#   5. 产物校验（stale-dist 防护）：dist 中必须能搜到本特性新增的路由/动作/模块字符串
#
# 任一失败 → exit 1。已知无关失败：MemoryProxy 的 `tsc --noEmit` 因可选子模块
# `@context-proxy/cost-guard` 缺失报一条错（仓库既有，不在本门禁内）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_TESTS="${SKIP_TESTS:-0}"
FAILED=()

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

run() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS  ${label}"
  else
    echo "FAIL  ${label}"
    FAILED+=("$label")
  fi
}

if [[ "$SKIP_TESTS" != "1" ]]; then
  step "1/4 MemoryCore: tests"
  run "MemoryCore tests" bash -c "cd '$ROOT/MemoryCore' && npx vitest run"
fi
step "1/4 MemoryCore: build"
run "MemoryCore build:plugin" bash -c "cd '$ROOT/MemoryCore' && npm run build:plugin"

if [[ "$SKIP_TESTS" != "1" ]]; then
  step "2/4 MemoryProxy: tests"
  run "MemoryProxy tests" bash -c "cd '$ROOT/MemoryProxy' && npx vitest run"
fi

if [[ "$SKIP_TESTS" != "1" ]]; then
  step "3/4 MemoryKnowledge: tests"
  run "MemoryKnowledge tests" bash -c "cd '$ROOT/MemoryKnowledge' && npx vitest run"
fi
step "3/4 MemoryKnowledge: build"
run "MemoryKnowledge build" bash -c "cd '$ROOT/MemoryKnowledge' && npm run build"

if [[ "$SKIP_TESTS" != "1" ]]; then
  step "4/4 MemoryPanel: tests"
  run "MemoryPanel tests" bash -c "cd '$ROOT/MemoryPanel' && npx vitest run"
fi
step "4/4 MemoryPanel: typecheck + build"
run "MemoryPanel typecheck" bash -c "cd '$ROOT/MemoryPanel' && npx tsc --noEmit"
run "MemoryPanel build" bash -c "cd '$ROOT/MemoryPanel' && npm run build"
step "4/4 MemoryPanel: web build"
run "MemoryPanel web build" bash -c "cd '$ROOT/MemoryPanel/web' && npm run build"

step "CI 对等门禁（.github/workflows/pr-ci.yml）"
run "skill queue isolation guard" bash -c "cd '$ROOT/MemoryCore' && MODE=working-tree bash scripts/ci/check-skill-queue-isolation.sh"

pack_gate() {
  local outdir
  outdir="$(mktemp -d)"
  if ! (cd "$ROOT/MemoryCore" && npm pack --pack-destination "$outdir" >/dev/null 2>&1); then
    echo "FAIL  npm pack"
    FAILED+=("npm pack")
    return
  fi
  local tgz size_kb
  tgz="$(ls -t "$outdir"/*.tgz 2>/dev/null | head -1)"
  if [[ -z "$tgz" ]]; then
    echo "FAIL  npm pack（未产出 tgz）"
    FAILED+=("npm pack artifact")
    return
  fi
  size_kb=$(( $(wc -c < "$tgz") / 1024 ))
  echo "      package size: ${size_kb} KB (limit 2048 KB)"
  if [[ "$size_kb" -gt 2048 ]]; then
    echo "FAIL  package size guard"
    FAILED+=("package size guard")
  else
    echo "PASS  package size guard"
  fi
}
pack_gate

step "产物校验（stale-dist 防护）"
check_dist() {
  local file="$1" needle="$2" label="$3"
  if [[ ! -f "$file" ]]; then
    echo "FAIL  ${label}: 缺少 $file"
    FAILED+=("$label")
    return
  fi
  if grep -q -- "$needle" "$file"; then
    echo "PASS  ${label}"
  else
    echo "FAIL  ${label}: ${file} 中找不到 '${needle}'（dist 可能是旧产物）"
    FAILED+=("$label")
  fi
}

P="$ROOT/MemoryPanel/dist"
check_dist "$P/panel/api/meta-actions.js" "instance-upstream/extraction/resync-knowledge" "Panel dist: resync action"
check_dist "$P/panel/api/meta-actions.js" "instance-upstream/extraction/test" "Panel dist: test action"
check_dist "$P/panel/http/routes/meta/model-config-test.js" "runModelConfigProbes" "Panel dist: probe route"
check_dist "$P/panel/http/routes/meta/model-config-resync.js" "syncKnowledgeBindingFromCore" "Panel dist: resync route"
check_dist "$P/panel/domain/model-config-probe.js" "REDIRECT_NOT_ALLOWED" "Panel dist: probe module"
check_dist "$ROOT/MemoryKnowledge/dist/server.mjs" "config_source" "KS dist: managed binding store"

step "结果"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "PASS  全部发布门禁通过"
  exit 0
fi
echo "FAIL  ${#FAILED[@]} 项未通过："
printf '  - %s\n' "${FAILED[@]}"
exit 1
