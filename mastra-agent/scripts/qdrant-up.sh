#!/usr/bin/env bash
# 拉起本地 Qdrant。优先使用 docker compose；本机没有 compose 插件时，
# 退回到与 docker-compose.rag.yml 语义等价的 docker run（同镜像、同端口、同命名卷）。
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/docker-compose.rag.yml"
IMAGE="qdrant/qdrant:v1.18.1"
NAME="customer-service-qdrant"
VOLUME="customer_service_qdrant_storage"
URL="${QDRANT_URL:-http://127.0.0.1:6333}"

if docker compose version >/dev/null 2>&1; then
  echo "使用 docker compose 插件启动 Qdrant"
  docker compose -f "$COMPOSE_FILE" up -d
elif command -v docker-compose >/dev/null 2>&1; then
  echo "使用 docker-compose v1 启动 Qdrant"
  docker-compose -f "$COMPOSE_FILE" up -d
else
  echo "未检测到 docker compose 插件或 docker-compose v1，退回等价的 docker run"
  echo "（配置与 docker-compose.rag.yml 一致：同镜像、同端口、同命名卷 $VOLUME）"
  if [ -n "$(docker ps -aq -f "name=^${NAME}$")" ]; then
    echo "容器 $NAME 已存在，直接启动"
    docker start "$NAME" >/dev/null
  else
    docker volume create "$VOLUME" >/dev/null
    docker run -d \
      --name "$NAME" \
      --restart unless-stopped \
      -p 127.0.0.1:6333:6333 \
      -p 127.0.0.1:6334:6334 \
      -e QDRANT__SERVICE__HTTP_PORT=6333 \
      -e QDRANT__SERVICE__GRPC_PORT=6334 \
      -e QDRANT__LOG_LEVEL=INFO \
      -v "${VOLUME}:/qdrant/storage" \
      --health-cmd "bash -c '</dev/tcp/127.0.0.1/6333' || exit 1" \
      --health-interval 10s \
      --health-timeout 5s \
      --health-retries 12 \
      --health-start-period 20s \
      "$IMAGE" >/dev/null
  fi
fi

echo -n "等待 Qdrant 健康"
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 "${URL}/readyz" >/dev/null 2>&1; then
    echo " -> 就绪"
    curl -fsS "${URL}/" | head -c 300
    echo
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " -> 超时"
echo "Qdrant 在 60 秒内未就绪，请检查：docker logs $NAME"
exit 1
