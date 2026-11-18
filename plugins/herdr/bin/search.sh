#!/bin/sh
# Popup `search`: find a past session (this project first; Tab or `/` for all
# projects) and resume or fork it in a split to the right of the source pane,
# or open it in the browser. fzf when installed, a numbered list otherwise.
CSH_BIN=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$CSH_BIN/lib.sh"

csh_loading
csh_init || exit 0
trap csh_cleanup EXIT
trap 'exit 130' INT TERM HUP

src=$(csh_source_pane)
csh_pane_info "$src"
csh_live_and_resolve "$CSH_PANE_SESSION" "$CSH_PANE_CWD" || exit 0
csh_save_live "$CSH_LIVE"
printf '%s' "$CSH_RESOLVE" >"$CSH_TMP/resolve.json"
csh_loaded

CSH_PROJECT=$(jq -r '.project.id // empty | strings' "$CSH_TMP/resolve.json")
project_cwd=$(jq -r "$CSH_JQ_DEFS"' .project.cwd // "" | clean' "$CSH_TMP/resolve.json")
CSH_PROJECT_NAME=${project_cwd##*/}
export CSH_BIN CSH_PROJECT CSH_PROJECT_NAME
printf 'project\n' >"$CSH_TMP/scope"

# act <key> <row>: 0 when the popup is done, non-zero to pick again.
act() {
  act_id=$(csh_row_id "$2")
  [ -n "$act_id" ] || return 1
  case $1 in
    open) csh_open_session "$act_id" "$(csh_row_title "$2")" ;;
    fork) csh_resume "$act_id" fork "$src" ;;
    *) csh_resume "$act_id" resume "$src" ;;
  esac
}

search_fzf() {
  while :; do
    # The bind/preview strings are fixed: $CSH_BIN is expanded by fzf's shell
    # (forced to sh) from the environment, and {q}/{1} are quoted by fzf.
    # shellcheck disable=SC2016
    out=$(csh_rows "" | SHELL=/bin/sh fzf --delimiter='\t' --with-nth=2.. --disabled \
      --prompt="$(csh_prompt)" \
      --header='Enter resume · Ctrl-F fork · Ctrl-O open in browser · Tab this project / all' \
      --expect=ctrl-f,ctrl-o \
      --bind='change:reload(sh "$CSH_BIN/fzf-helper.sh" rows {q})' \
      --bind='tab:execute-silent(sh "$CSH_BIN/fzf-helper.sh" toggle)+reload(sh "$CSH_BIN/fzf-helper.sh" rows {q})+transform-prompt(sh "$CSH_BIN/fzf-helper.sh" prompt)' \
      --preview='sh "$CSH_BIN/fzf-helper.sh" preview {1}' --preview-window=right,50%,wrap) || return 0
    key=$(printf '%s\n' "$out" | sed -n 1p)
    line=$(printf '%s\n' "$out" | sed -n 2p)
    case $key in
      ctrl-o) act open "$line" && return 0 ;;
      ctrl-f) act fork "$line" && return 0 ;;
      *) act resume "$line" && return 0 ;;
    esac
  done
}

search_list() {
  q=
  while :; do
    csh_rows "$q" >"$CSH_TMP/rows.tsv"
    if [ "$(csh_scope)" = project ]; then
      printf '\nclaudescope · %s (%s)' "$CSH_PROJECT_NAME" "$project_cwd"
    else
      printf '\nclaudescope · all projects'
    fi
    [ -n "$q" ] && printf ' · "%s"' "$(printf '%s' "$q" | tr -d '\000-\037\177')"
    printf '\n\n'
    csh_print_rows "$CSH_TMP/rows.tsv" 20
    printf '\nn resume · f<n> fork · o<n> open · /text search all · / this project · q quit\n> '
    IFS= read -r ans || return 0
    case $ans in
      q | Q) return 0 ;;
      /)
        q=
        printf 'project\n' >"$CSH_TMP/scope"
        continue
        ;;
      /*)
        q=${ans#/}
        printf 'all\n' >"$CSH_TMP/scope"
        continue
        ;;
      f*) mode=fork n=${ans#f} ;;
      o*) mode=open n=${ans#o} ;;
      *) mode=resume n=$ans ;;
    esac
    if ! line=$(csh_row_at "$CSH_TMP/rows.tsv" "$n"); then
      printf 'No row %s.\n' "$n"
      continue
    fi
    act "$mode" "$line" && return 0
  done
}

# The Tab binding uses transform-prompt (fzf 0.36); an older fzf rejects the
# action and exits 2, which would close the popup silently.
fzf_ok() {
  command -v fzf >/dev/null 2>&1 || return 1
  fo_ver=$(fzf --version 2>/dev/null | sed -n '1s/^\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
  [ -n "$fo_ver" ] || return 0
  fo_major=${fo_ver% *}
  fo_minor=${fo_ver#* }
  if [ "$fo_major" -gt 0 ] || [ "$fo_minor" -ge 36 ]; then
    return 0
  fi
  csh_toast "fzf $fo_major.$fo_minor is too old (0.36+ needed); using the numbered list"
  return 1
}

if fzf_ok; then
  search_fzf
else
  search_list
fi
exit 0
