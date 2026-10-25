#!/usr/bin/env bash
# AQspace board helper (GitHub Project #2). Usage:
#   scripts/board.sh move <issue#> "<Backlog|Todo|In Progress|In Review|QA|Done>"
#   scripts/board.sh add <issue#> [status]        # put an existing issue on the board
#   scripts/board.sh list                         # issue number, status, title
set -euo pipefail
GH="$(cd "$(dirname "$0")" && pwd)/gh.sh"
OWNER=secretJod REPO=secretJod/AqSpace NUM=2
PROJECT_ID=PVT_kwHOCJYqXM4BosB7
STATUS_FIELD=PVTSSF_lAHOCJYqXM4BosB7zhnK73E

option_id() {
  case "$1" in
    Backlog) echo 96483b54 ;; Todo) echo 95815ccf ;; "In Progress") echo 319028e9 ;;
    "In Review") echo 09782fe0 ;; QA) echo a1872003 ;; Done) echo 2c9aecd4 ;;
    *) echo "unknown status: $1" >&2; exit 1 ;;
  esac
}

item_id() {
  "$GH" project item-list "$NUM" --owner "$OWNER" --limit 500 --format json \
    --jq ".items[] | select(.content.number == $1) | .id"
}

case "${1:-}" in
  move)
    [ "$3" = "Done" ] && [ "${QA_APPROVED:-}" != "1" ] && { echo "Only the QA tester moves cards to Done." >&2; exit 1; }
    id="$(item_id "$2")"; [ -n "$id" ] || { echo "issue #$2 is not on the board" >&2; exit 1; }
    "$GH" project item-edit --id "$id" --project-id "$PROJECT_ID" --field-id "$STATUS_FIELD" \
      --single-select-option-id "$(option_id "$3")" >/dev/null
    echo "#$2 -> $3" ;;
  add)
    id="$("$GH" project item-add "$NUM" --owner "$OWNER" --url "https://github.com/$REPO/issues/$2" --format json --jq .id)"
    "$GH" project item-edit --id "$id" --project-id "$PROJECT_ID" --field-id "$STATUS_FIELD" \
      --single-select-option-id "$(option_id "${3:-Backlog}")" >/dev/null
    echo "#$2 -> ${3:-Backlog}" ;;
  list)
    "$GH" project item-list "$NUM" --owner "$OWNER" --limit 500 --format json \
      --jq '.items[] | "#\(.content.number)\t\(.status // "-")\t\(.title)"' | sort -t'#' -k2 -n ;;
  *) sed -n 2,5p "$0"; exit 1 ;;
esac
