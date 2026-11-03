#!/usr/bin/env bash
# Reproduce 《末班车暗号》 local store state via CLI (no paid calls).
set -euo pipefail
FIX="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$FIX/../../../.." && pwd)"
CLI=(node "$ROOT/scripts/grokbot-native-tools/cli.mjs")
STORE="${ADS_LOCAL_STORE:-$FIX/.store.json}"
rm -f "$STORE"
"${CLI[@]}" create \
  --title "末班车暗号" \
  --premise "暴雨夜末班车误点，两个陌生人交换一个不能说错的暗号" \
  --genre "悬疑" --audience "年轻观众" --episodes 3 \
  --store "$STORE" >/dev/null
"${CLI[@]}" save-script --text-file "$FIX/script.txt" --script-title "剧本修订 1" --store "$STORE" >/dev/null
"${CLI[@]}" approve-script --approved-by "user:yingqun-xu" --store "$STORE" >/dev/null
"${CLI[@]}" set-characters --characters-file "$FIX/characters.json" --store "$STORE" >/dev/null
"${CLI[@]}" set-storyboard --scene-file "$FIX/scene.json" --store "$STORE" >/dev/null
"${CLI[@]}" approve-scene --approved-by "user:yingqun-xu" --store "$STORE" >/dev/null
"${CLI[@]}" voice-plan --store "$STORE" >/dev/null
"${CLI[@]}" status --store "$STORE"
echo "STORE=$STORE" >&2
