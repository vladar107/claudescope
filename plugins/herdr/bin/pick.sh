#!/bin/sh
# Popup `pick`: several live sessions share the pane's folder; choose the one
# to open. The candidates arrive as the `resolve --json` result in the file
# named by CSH_PICK_FILE (written by open-session.sh, deleted here).
CSH_BIN=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$CSH_BIN/lib.sh"

# The file holds session titles: read it and delete it before anything that
# can exit early (csh_init).
pick=${CSH_PICK_FILE:-}
if [ -z "$pick" ] || [ ! -r "$pick" ]; then
  printf 'claudescope: no candidates to pick from.\n'
  csh_wait_close
  exit 0
fi
candidates=$(cat "$pick")
rm -f "$pick"

csh_init || exit 0
trap csh_cleanup EXIT
trap 'exit 130' INT TERM HUP
export CSH_BIN

printf '%s\n' "$candidates" >"$CSH_TMP/resolve.json"

jq '[.sessions[]? | select(.live) | .meta.id | strings]' "$CSH_TMP/resolve.json" >"$CSH_TMP/live.json"
# A non-live candidate is the pane's own recorded session (a stale id); the live
# ones stay first.
stale=$(jq -r 'any(.sessions[]?; .live != true)' "$CSH_TMP/resolve.json")
jq '[.sessions[]? | select(.live == true) | .meta]
    + [.sessions[]? | select(.live != true) | .meta | .title = "this pane'"'"'s recorded session (not live) · " + (.title // "")]' "$CSH_TMP/resolve.json" | csh_rows_sessions >"$CSH_TMP/rows.tsv"
if [ "$stale" = true ]; then
  heading="Which session is this pane?"
  intro="claudescope · which session is this pane?"
else
  heading="Live sessions"
  intro="claudescope · live sessions"
fi
where=$(jq -r "$CSH_JQ_DEFS"' .project.cwd // "" | clean' "$CSH_TMP/resolve.json")

if command -v fzf >/dev/null 2>&1; then
  # $CSH_BIN is expanded by fzf's shell from the environment, not spliced here.
  # shellcheck disable=SC2016
  line=$(SHELL=/bin/sh fzf --delimiter='\t' --with-nth=2.. --prompt='session> ' \
    --header="$heading in ${where:-this folder} · Enter opens in claudescope" \
    --preview='sh "$CSH_BIN/fzf-helper.sh" preview {1}' --preview-window=right,50%,wrap \
    <"$CSH_TMP/rows.tsv") || exit 0
else
  printf '%s in %s\n\n' "$intro" "${where:-this folder}"
  csh_print_rows "$CSH_TMP/rows.tsv" 20
  while :; do
    printf '\nn open · q quit\n> '
    IFS= read -r ans || exit 0
    case $ans in
      q | Q) exit 0 ;;
    esac
    line=$(csh_row_at "$CSH_TMP/rows.tsv" "$ans") && break
    printf 'No row %s.\n' "$ans"
  done
fi

id=$(csh_row_id "$line")
[ -n "$id" ] && csh_open_session "$id" "$(csh_row_title "$line")"
exit 0
