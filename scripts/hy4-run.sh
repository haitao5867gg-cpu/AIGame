#!/bin/bash
# Dispatch one coding task to Hy4 (CodeBuddy CLI) and wait for it to finish.
# usage: scripts/hy4-run.sh <task-name> <prompt-file>
#   e.g. scripts/hy4-run.sh fix-scroll .logs/fix-scroll.txt   → log in .logs/fix-scroll.json (+ .fallback notes)
# Tries the free model hy4free first; only if THIS run gets a 429 / quota error does it retry once with paid hy4.
# --autocompact 256k avoids CodeBuddy's forced compaction at ~200k tokens; if the model rejects the larger
# context, the run is retried once with the default compaction. Runs with --permission-mode acceptEdits
# (allowed shell commands are listed in .codebuddy/settings.json); never use -y.
cd "$(dirname "$0")/.." || exit 1
mkdir -p .logs
M=hy4free
AC="--autocompact 256k"
run() { codebuddy -p "$(cat "$2")" --model "$1" $AC --permission-mode acceptEdits --output-format json < /dev/null > ".logs/$3.json" 2>&1; }
run $M "$2" "$1"; rc=$?
if grep -qiE 'context.?length|too many tokens|maximum context|prompt is too long|超出.*(长度|上下文)|上下文.*(超|过长)' <(tail -c 4000 ".logs/$1.json") && ! grep -q '"type": "result"' ".logs/$1.json"; then
  echo "context too long with $AC, retrying with default compaction" >> ".logs/$1.fallback"
  AC=""; run $M "$2" "$1"; rc=$?
fi
if grep -qiE '429|频率限制|quota|额度|exceed|insufficient|rate.?limit' <(head -c 2000 ".logs/$1.json") && ! grep -q '"type": "result"' ".logs/$1.json"; then
  echo "free quota exhausted, retrying with paid hy4" >> ".logs/$1.fallback"
  run hy4 "$2" "$1"; rc=$?
fi
echo "exit=$rc" >> ".logs/$1.json"
