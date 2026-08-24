#!/usr/bin/env bash
# 打包 Luckagent 安装包：
#   bash scripts/make-installer.sh [版本号]
# 产出 ~/luckagent-dist/luckagent-installer-v<版本>.tar.gz（含 SHA256）。
# 从 git HEAD 打包 —— 未提交的改动不会进包；包内不含 node_modules / dist。

set -euo pipefail

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo 0.1.0)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${LUCKAGENT_DIST_DIR:-$HOME/luckagent-dist}"
OUT_FILE="$OUT_DIR/luckagent-installer-v${VERSION}.tar.gz"

cd "$REPO_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[WARN] 工作区有未提交改动 —— 它们不会进入安装包（打包基于 git HEAD）。"
fi

echo "[INFO] 校验构建可用性（npm run build）..."
npm run build >/dev/null

mkdir -p "$OUT_DIR"
echo "[INFO] 打包 git HEAD → $OUT_FILE"
git archive HEAD --prefix=luckagent/ | gzip > "$OUT_FILE"

SHA="$(shasum -a 256 "$OUT_FILE" | awk '{print $1}')"
echo "$SHA  $(basename "$OUT_FILE")" > "$OUT_FILE.sha256"

echo ""
echo "[OK] 安装包已生成:"
echo "     $OUT_FILE"
echo "     SHA256: $SHA"
echo ""
echo "拷到目标机后："
echo "  shasum -a 256 -c $(basename "$OUT_FILE").sha256   # 校验"
echo "  tar -xzf $(basename "$OUT_FILE") && cd luckagent && bash install.sh"
