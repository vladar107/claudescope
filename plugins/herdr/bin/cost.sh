#!/bin/sh
# Popup `cost`: the estimated cost today / last 7 days / last 30 days (local
# dates), this pane's session, and the costliest sessions of the last 7 days,
# for the pane's project or for all projects (Tab switches). `o` opens
# claudescope in the browser, `q` closes.
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
printf '%s' "$CSH_RESOLVE" >"$CSH_TMP/resolve.json"

project=$(jq -r '.project.id // empty | strings' "$CSH_TMP/resolve.json")
scope=project
[ -n "$project" ] || scope=all

d0=$(csh_date_ago 0)
d6=$(csh_date_ago 6)
d29=$(csh_date_ago 29)
if [ -z "$d0" ] || [ -z "$d6" ] || [ -z "$d29" ]; then
  csh_loaded
  printf '\n  claudescope: could not compute the local dates for the cost ranges\n'
  csh_wait_close
  exit 0
fi

# fetch_call <scope> <name> <empty-result> <claudescope args…>: one call into
# <scope>-<name>.json; a failed call leaves the empty result.
fetch_call() {
  fc_out=$CSH_TMP/$1-$2.json fc_empty=$3
  shift 3
  "$CSH_CLI" "$@" >"$fc_out" 2>/dev/null || printf '%s\n' "$fc_empty" >"$fc_out"
}

# fetch <scope>: the three analytics ranges and the session list of a scope,
# run concurrently and all waited for. Done once per scope, so toggling back
# is instant.
fetch() {
  [ -e "$CSH_TMP/fetched-$1" ] && return 0
  fetch_pf=
  [ "$1" = project ] && fetch_pf="--project=$project"
  fetch_call "$1" d0 '{}' analytics --group-by project ${fetch_pf:+"$fetch_pf"} "--from=$d0" --json &
  fetch_p1=$!
  fetch_call "$1" d6 '{}' analytics --group-by project ${fetch_pf:+"$fetch_pf"} "--from=$d6" --json &
  fetch_p2=$!
  fetch_call "$1" d29 '{}' analytics --group-by project ${fetch_pf:+"$fetch_pf"} "--from=$d29" --json &
  fetch_p3=$!
  fetch_call "$1" sessions '[]' sessions ${fetch_pf:+"$fetch_pf"} --sort recent --limit 200 --json &
  fetch_p4=$!
  wait "$fetch_p1" "$fetch_p2" "$fetch_p3" "$fetch_p4"
  : >"$CSH_TMP/fetched-$1"
}

# render <scope>
render() {
  jq -nr --slurpfile r "$CSH_TMP/resolve.json" --slurpfile s "$CSH_TMP/$1-sessions.json" \
    --slurpfile t0 "$CSH_TMP/$1-d0.json" --slurpfile t6 "$CSH_TMP/$1-d6.json" \
    --slurpfile t29 "$CSH_TMP/$1-d29.json" --arg d6 "$d6" --arg scope "$1" \
    --arg tab "${project:+Tab project/all · }" "$CSH_JQ_DEFS"'
  def total($a): ($a[0].totals // {}) as $t
    | "\($t.costUsd // 0 | money | lpad(9))   \($t.totalTokens // 0 | tok) tokens · \($t.messageCount // 0) responses";
  def ended: (.endedAt // "" | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch 0);
  def where: if $scope == "all" then (.projectDisplayName // "" | clean | pad(14)) + " " else "" end;
  (now | floor) as $now
  | (($now | localtime | mktime) - $now) as $off
  | (($d6 + "T00:00:00Z" | fromdateiso8601) - $off) as $cutoff
  | $r[0] as $res
  | ($res.project.cwd // "" | clean) as $cwd
  | "",
    (if $scope == "all" then "  claudescope · cost · all projects"
     else "  claudescope · cost · this project · \($cwd | split("/") | last)   \($cwd)" end),
    "",
    "  Today        \(total($t0))",
    "  Last 7 days  \(total($t6))",
    "  Last 30 days \(total($t29))",
    "",
    (if ($res.match == "id" or $res.match == "live" or $res.match == "recent") then
       ($res.sessions[0].meta) as $m
       | "  This pane    \($m.title // "" | clean | .[0:70])"
         + (if $res.match == "recent" then "   (matched by folder)" else "" end),
         "               \($m.totalCostUsd | money) · \($m.totalTokens | tok) tokens · \($m.messageCount // 0) messages"
     elif $res.match == "ambiguous" then
       "  This pane    \($res.sessions | map(select(.live == true)) | length) live sessions in this folder"
     else
       "  This pane    no session matched"
     end),
    "",
    "  Top sessions, last 7 days",
    ([ $s[0][]? | select(ended >= $cutoff) ]
      | sort_by(-(.totalCostUsd // 0)) | .[0:5]
      | if length == 0 then "    none" else
          .[] | "    \(.totalCostUsd | money | lpad(9))  \(.connectorId // "" | clean | pad(12)) \(.endedAt | day)  \(where)\(.title // "" | clean | .[0:60])"
        end),
    "",
    "  \($tab)o open Claudescope · q close"'
}

drawn=
# show: fetch the scope if needed, then draw it.
show() {
  if [ ! -e "$CSH_TMP/fetched-$scope" ]; then
    # The first fetch is already covered by the popup's opening line.
    [ -n "$drawn" ] && csh_loading
    fetch "$scope"
    csh_loaded
  fi
  drawn=1
  [ -t 1 ] && printf '\033[2J\033[H'
  render "$scope"
}

show
while :; do
  key=$(csh_read_key) || key=q
  case $key in
    "$CSH_TAB")
      if [ -n "$project" ]; then
        if [ "$scope" = project ]; then scope=all; else scope=project; fi
        show
      fi
      ;;
    o | O)
      if "$CSH_CLI" open >/dev/null 2>&1; then
        url=$(csh_url) || url=
        [ -n "$url" ] && csh_toast "Opened claudescope — $url"
      else
        csh_toast "claudescope could not open the browser"
      fi
      exit 0
      ;;
    q | Q | "$(printf '\033')") exit 0 ;;
  esac
done
