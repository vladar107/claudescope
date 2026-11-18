#!/bin/sh
# Actions `search` and `cost`: open the popup of the same name. A popup gets
# no HERDR_PANE_ID, so the pane the key was pressed in travels as CSH_SRC_PANE
# (the split for a resume opens next to it).
CSH_BIN=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$CSH_BIN/lib.sh"

case ${1:-} in
  search | cost) ;;
  *)
    echo "usage: open-pane.sh search|cost" >&2
    exit 2
    ;;
esac

pane=$(csh_source_pane)
set -- plugin pane open --plugin "$CSH_PLUGIN_ID" --entrypoint "$1"
[ -n "$pane" ] && set -- "$@" --env "CSH_SRC_PANE=$pane"
"$CSH_HERDR" "$@" >/dev/null 2>&1 || csh_toast "herdr could not open the claudescope popup"
exit 0
