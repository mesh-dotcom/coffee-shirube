#!/usr/bin/env bash
# 点検の結果を Issue で知らせる。問題があれば「自動チェック」の Issue を作る（開いていれば追記する）。
# 問題が無くなったら、その Issue を閉じる。直すのは、毎朝動く Claude の定期実行（README の「毎日の点検と修正」）。
set -uo pipefail
label="自動チェック"
report="${HEALTH_OUT:-}"
body=""
[ -n "$report" ] && [ -f "$report" ] && body="$(cat "$report")"
if [ "${COLLECT_OK:-true}" != "true" ]; then
  body="## ❌ 収集の実行が失敗しました

ログ: ${RUN_URL}

${body}"
fi
cat "${report:-/dev/null}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true

gh label create "$label" --color D93F0B --description "毎日の収集の点検で見つかった問題" --force >/dev/null 2>&1 || true
open="$(gh issue list --label "$label" --state open --json number --jq '.[0].number' 2>/dev/null || true)"

if [ "${COLLECT_OK:-true}" = "true" ] && [ "${HEALTH_OK:-}" = "true" ]; then
  if [ -n "$open" ]; then
    gh issue close "$open" --comment "$(printf '%s\n\nこの回の点検では問題がなかったので閉じます（%s）' "$body" "$RUN_URL")"
  fi
  echo "問題はありませんでした"
  exit 0
fi

if [ -n "$open" ]; then
  gh issue comment "$open" --body "$(printf '%s\n\n実行: %s' "$body" "$RUN_URL")"
else
  gh issue create --title "収集の点検で問題が見つかりました（$(date -u +%Y-%m-%d)）" --label "$label" \
    --body "$(printf '%s\n\n実行: %s' "$body" "$RUN_URL")"
fi
