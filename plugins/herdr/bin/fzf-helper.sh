#!/bin/sh
# fzf callbacks for the search and pick popups. fzf runs these through fixed
# strings whose only variable parts are its own quoted placeholders ({q},
# {1}); everything else arrives through the environment the popup exported.
CSH_BIN=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$CSH_BIN/lib.sh"

[ -n "${CSH_CLI:-}" ] && [ -n "${CSH_TMP:-}" ] && [ -d "$CSH_TMP" ] || exit 1

case ${1:-} in
  rows) csh_rows "${2:-}" ;;
  toggle)
    if [ "$(csh_scope)" = project ]; then
      printf 'all\n' >"$CSH_TMP/scope"
    else
      printf 'project\n' >"$CSH_TMP/scope"
    fi
    ;;
  prompt) csh_prompt ;;
  preview) csh_preview "${2:-}" ;;
  *) exit 2 ;;
esac
