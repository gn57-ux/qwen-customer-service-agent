#!/usr/bin/env bash
# 停止本地 Qdrant。**只停容器，不删数据卷**——命名卷 customer_service_qdrant_storage
# 保留，下次 up 后 Collection 与向量仍在。
# 真要清空数据需要手动执行：docker volume rm customer_service_qdrant_storage
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/docker-compose.rag.yml"
NAME="customer-service-qdrant"

if docker compose version >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_FILE" down
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f "$COMPOSE_FILE" down
else
  if [ -n "$(docker ps -aq -f "name=^${NAME}$")" ]; then
    docker stop "$NAME" >/dev/null && docker rm "$NAME" >/dev/null
    echo "已停止并移除容器 $NAME"
  else
    echo "容器 $NAME 不存在，无需操作"
  fi
fi

echo "数据卷 customer_service_qdrant_storage 已保留（未删除）"
