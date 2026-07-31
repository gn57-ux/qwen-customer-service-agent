#!/usr/bin/env bash
# 门禁 6（8.F-006/AC-006）：召回/重排文案附近不得出现 20/5 硬编码计数。
#
# 已知盲区（design.md 模块 2）：变量名绕过（如 const TOP_5 = 5）无法被文案
# 正则捕获。补偿手段见 evidence/derive.test.ts 用非 20/5 的构造值（17/3）
# 断言渲染结果，从行为层面兜住这个盲区，不是本脚本单独能覆盖的。
set -euo pipefail
cd "$(dirname "$0")/.."

if grep -rnE '(已召回|重排完成|Top)\s*[·:]?\s*(20|5)\b' src \
  --include='*.ts' --include='*.tsx'; then
  echo '❌ 检测到召回/重排计数硬编码'
  exit 1
else
  echo '✅ 无硬编码计数'
fi
