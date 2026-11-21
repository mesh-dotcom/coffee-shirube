#!/usr/bin/env bash
# data/ の変更をコミットして送る。実行中にリポジトリが手で編集されていても保存できるよう、取りこんでから送る。
# 同じ箇所がぶつかったときは、手で編集した内容を優先する。
set -euo pipefail
message="${1:-データを更新}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add data/
if git diff --cached --quiet; then
  echo "変更はありませんでした"
  exit 0
fi
git commit -q -m "${message} $(date -u +%Y-%m-%dT%H:%MZ)"
branch="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"
for attempt in 1 2 3; do
  git fetch -q origin "${branch}"
  if ! git rebase -q -X ours "origin/${branch}"; then
    git rebase --abort || true
    echo "::error::手で編集した内容と重なって保存できませんでした。もう一度実行してください"
    exit 1
  fi
  if git push -q origin "HEAD:${branch}"; then
    echo "保存しました"
    exit 0
  fi
  echo "ほかの変更と重なったので、やりなおします（${attempt}回目）"
  sleep 5
done
echo "::error::保存できませんでした"
exit 1
