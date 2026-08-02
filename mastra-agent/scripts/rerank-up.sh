#!/usr/bin/env bash
# 启动本地 Reranker（llama.cpp llama-server，Apple Metal）。
#
# 只监听 127.0.0.1:8787，PID 写入 mastra-agent/.runtime/rerank-server.pid。
# 重复执行能识别已运行实例，不会重复拉起。
set -euo pipefail

MASTRA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${RERANK_MODEL_PATH:-$MASTRA_ROOT/.models/bge-reranker-v2-m3-Q8_0.gguf}"
HOST="127.0.0.1"
PORT="${RERANK_PORT:-8787}"
RUNTIME_DIR="$MASTRA_ROOT/.runtime"
PID_FILE="$RUNTIME_DIR/rerank-server.pid"
LOG_FILE="$RUNTIME_DIR/rerank-server.log"
URL="http://${HOST}:${PORT}"

mkdir -p "$RUNTIME_DIR"

# ---- 已运行实例识别 -------------------------------------------------------
# 只有四项**同时**满足才认定"是本脚本托管的实例"：
#   1) PID 存活  2) 命令行含 llama-server
#   3) 命令行含当前 MODEL 的 basename  4) ${URL}/health 可达
# 任一不满足且进程仍存活时：不接管、不停止、不删除该 PID 文件，直接报错退出非零。
MODEL_BASENAME="$(basename "$MODEL")"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"

  if [ -z "$OLD_PID" ]; then
    echo "PID 文件为空，按陈旧记录清理。"
    rm -f "$PID_FILE"
  elif ! kill -0 "$OLD_PID" 2>/dev/null; then
    echo "PID $OLD_PID 已不存在，清理陈旧 PID 文件。"
    rm -f "$PID_FILE"
  else
    # 进程存活 —— 逐项校验，不因为"是个 llama-server"就直接认领
    CMD="$(ps -o command= -p "$OLD_PID" 2>/dev/null || true)"
    PROBLEMS=""

    if ! printf '%s' "$CMD" | grep -q "llama-server"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含 llama-server
"
    fi
    if ! printf '%s' "$CMD" | grep -q "$MODEL_BASENAME"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含本项目模型 ${MODEL_BASENAME}
"
    fi
    if ! curl -fsS --max-time 3 "${URL}/health" >/dev/null 2>&1; then
      PROBLEMS="${PROBLEMS}  - 健康检查 ${URL}/health 不可达
"
    fi

    if [ -z "$PROBLEMS" ]; then
      echo "Reranker 已在运行（PID $OLD_PID），四项校验通过，不重复启动。"
      echo "  进程存活 / llama-server / 模型 ${MODEL_BASENAME} / ${URL} 健康"
      exit 0
    fi

    {
      echo "PID 文件指向存活进程 $OLD_PID，但校验未通过："
      printf '%s' "$PROBLEMS"
      echo "  实际命令行：$CMD"
      echo "为避免误接管或误杀，本脚本不接管、不停止该进程，也不删除该 PID 文件。"
      echo "请人工确认后处理（确认无用可自行结束该进程并删除 $PID_FILE）。"
    } >&2
    exit 1
  fi
fi

if curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
  echo "端口 ${PORT} 上已有服务在响应，但没有本脚本记录的 PID 文件。"
  echo "为避免误管理他人进程，这里不接管、不停止该进程。"
  echo "请确认它是否是你手动启动的 Reranker；如需由本脚本托管，请先自行停止它。"
  exit 1
fi

# ---- 前置检查 -------------------------------------------------------------
if ! command -v llama-server >/dev/null 2>&1; then
  echo "未找到 llama-server。请先安装：brew install llama.cpp" >&2
  exit 1
fi
if [ ! -f "$MODEL" ]; then
  echo "未找到模型文件：$MODEL" >&2
  echo "请按 mastra-agent/reranker-model.lock.json 里的 downloadUrl 下载后重试。" >&2
  exit 1
fi

# ---- 启动 -----------------------------------------------------------------
# 参数以本机 llama-server --help 实测为准：
#   --reranking  enable reranking endpoint on server
#   --embedding  restrict to only support embedding use case
#   --pooling rank
echo "启动 Reranker：$(basename "$MODEL")"
nohup llama-server \
  --model "$MODEL" \
  --reranking \
  --embedding \
  --pooling rank \
  --host "$HOST" \
  --port "$PORT" \
  >"$LOG_FILE" 2>&1 &

NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "PID $NEW_PID -> $PID_FILE"

# ---- 健康等待 -------------------------------------------------------------
echo -n "等待服务就绪"
for _ in $(seq 1 90); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo " -> 进程已退出"
    echo "启动失败，日志尾部：" >&2
    tail -20 "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  if curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
    echo " -> 就绪"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
  echo " -> 超时"
  echo "服务在 90 秒内未就绪，日志尾部：" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

# ---- smoke test：真实打一次 rerank ----------------------------------------
SMOKE="$(curl -fsS --max-time 60 "${URL}/v1/rerank" \
  -H 'Content-Type: application/json' \
  -d '{"model":"reranker","query":"冰箱不制冷怎么办","documents":["冰箱制冷异常的排查步骤","显示器无信号排查"],"top_n":2}' 2>/dev/null || true)"

if [ -z "$SMOKE" ]; then
  echo "smoke test 失败：/v1/rerank 没有返回内容。" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

SMOKE_OUT="$(printf '%s' "$SMOKE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception as exc:
    print('smoke test 失败：响应不是合法 JSON', file=sys.stderr)
    sys.exit(1)
results = data.get('results')
if not isinstance(results, list) or not results:
    print('smoke test 失败：响应中没有 results', file=sys.stderr)
    sys.exit(1)
first = results[0]
if 'index' not in first or 'relevance_score' not in first:
    print('smoke test 失败：结果缺少 index 或 relevance_score', file=sys.stderr)
    sys.exit(1)
print('smoke test 通过：返回 %d 条，Top1 index=%s score=%.4f' % (len(results), first['index'], first['relevance_score']))
")" || {
  echo "smoke test 失败，日志尾部：" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
}
echo "$SMOKE_OUT"

echo "Reranker 就绪：$URL"
