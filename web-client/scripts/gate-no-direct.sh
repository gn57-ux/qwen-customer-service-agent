#!/usr/bin/env bash
# 门禁 5（8.F-005/AC-005）：源码禁止直连下游服务或绕过 MastraClient。
# 6 个禁用端口：8000 FastAPI / 8001 Mock 后端 / 8002 llama-server /
# 6333 Qdrant / 8787 Reranker / 11434 Ollama Embedding（v2 新增）。
#
# 排除 client.ts 自身：其顶部注释合法地提到这些端口作为"禁止直连"的说明文字，
# 扫描它只会产生永久假阳性——真的在 client.ts 里引入直连由 code review 与
# 2.T-007 的实现约束兜底，不是这个脚本的职责（design.md 模块 2）。
set -euo pipefail
cd "$(dirname "$0")/.."

if grep -rnE ':(8000|8001|8002|6333|8787|11434)|getAgent\(' src \
  --include='*.ts' --include='*.tsx' \
  --exclude='client.ts'; then
  echo '❌ 检测到禁止的直连或绕过用法'
  exit 1
else
  echo '✅ 无直连'
fi
