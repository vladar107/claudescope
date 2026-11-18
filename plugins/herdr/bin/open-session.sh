#!/bin/sh
# Action `open-session`: open the focused pane's agent session in Claudescope.
# Exact agent session id first, else the pane's folder; several live sessions
# in that folder open the `pick` popup.
CSH_BIN=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$CSH_BIN/lib.sh"

csh_init || exit 0
trap csh_cleanup EXIT
trap 'exit 130' INT TERM HUP

pane=$(csh_source_pane)
csh_pane_info "$pane"
if [ -z "$CSH_PANE_SESSION" ] && [ -z "$CSH_PANE_CWD" ]; then
  csh_toast "This pane has no agent session or folder to match"
  exit 0
fi

csh_live_json >/dev/null || exit 0
res=$(csh_resolve "$CSH_PANE_SESSION" "$CSH_PANE_CWD") || exit 0
printf '%s' "$res" >"$CSH_TMP/resolve.json"

match=$(jq -r '.match // "none"' "$CSH_TMP/resolve.json")
id=$(jq -r '.sessions[0].meta.id // empty | strings' "$CSH_TMP/resolve.json")
title=$(jq -r "$CSH_JQ_DEFS"' .sessions[0].meta.title // "" | clean | .[0:80]' "$CSH_TMP/resolve.json")

case $match in
  id | live)
    [ -n "$id" ] && csh_open_session "$id" "$title"
    ;;
  recent)
    [ -n "$id" ] && csh_open_session "$id" "$title" "Matched by folder (no live session here): "
    ;;
  ambiguous)
    state=${HERDR_PLUGIN_STATE_DIR:-${TMPDIR:-/tmp}}
    mkdir -p "$state"
    # The popup deletes the file once read; it is removed here only if the
    # popup never opens.
    pick=$(mktemp "$state/pick.XXXXXX") || exit 0
    cp "$CSH_TMP/resolve.json" "$pick"
    if ! "$CSH_HERDR" plugin pane open --plugin "$CSH_PLUGIN_ID" --entrypoint pick \
      --env "CSH_PICK_FILE=$pick" --env "CSH_SRC_PANE=$pane" >/dev/null 2>&1; then
      rm -f "$pick"
      csh_toast "herdr could not open the session picker"
    fi
    ;;
  *)
    where=$(printf '%s' "$CSH_PANE_CWD" | jq -Rr "$CSH_JQ_DEFS clean")
    csh_toast "No claudescope session for this pane${where:+ ($where)}"
    ;;
esac
exit 0
