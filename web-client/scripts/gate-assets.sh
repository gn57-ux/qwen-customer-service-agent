#!/usr/bin/env bash
# 门禁 7（8.F-007/AC-007）：设计资产完整性——字节数与 SHA-256 与需求 §1.5.1
# 基线一致。防止设计稿资产被意外替换/截断而无人察觉。
set -euo pipefail
cd "$(dirname "$0")/../../frontend-workbench/docs/assets"

shasum -a 256 -c checksums.txt
