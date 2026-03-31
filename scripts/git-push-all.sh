#!/usr/bin/env bash
# 依次推送到 Gitee（origin）与 GitHub（github）。
# GitHub 因网络/鉴权失败时不退出非零，便于下次再推时一并补上。
set -euo pipefail

BRANCH="${1:-$(git branch --show-current)}"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "[push-all] 错误：未配置 remote origin" >&2
  exit 1
fi

echo "[push-all] 推送 origin (Gitee) 分支: $BRANCH"
git push origin "$BRANCH"

if ! git remote get-url github >/dev/null 2>&1; then
  echo "[push-all] 未配置 remote github，跳过 GitHub。添加方式："
  echo "  git remote add github git@github.com:jiangrong2001/feishu-cursor-bridge.git"
  exit 0
fi

echo "[push-all] 推送 github 分支: $BRANCH"
if git push github "$BRANCH"; then
  echo "[push-all] 完成：Gitee 与 GitHub 均已更新。"
else
  echo "[push-all] GitHub 推送失败（常见为网络或 SSH），已跳过；本地提交仍在，下次运行本脚本或手动 git push github 会一并推送。"
fi
