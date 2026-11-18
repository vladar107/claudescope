# shellcheck shell=sh
# Shared helpers for the Claudescope herdr plugin. Sourced by the entry
# scripts, never run on its own. POSIX sh: no `local`, so helper variables
# carry a per-function prefix.
#
# Rules every caller keeps: claudescope and herdr are called with argv only
# (nothing is eval'ed or passed to `sh -c`), data values go after `=` or `--`
# so a leading dash can't turn into a flag, and every string that came from a
# transcript passes through `clean` (jq) before it reaches a terminal.

# Session titles and candidate lists land in temp and state files.
umask 077

CSH_PLUGIN_ID=${HERDR_PLUGIN_ID:-claudescope}
CSH_HERDR=${HERDR_BIN_PATH:-herdr}

# jq helpers shared by every renderer. `clean` replaces C0/C1 control
# characters (ESC, CSI, BEL, tab, newline…) so transcript text can't drive the
# terminal or break the tab-delimited fzf rows.
# shellcheck disable=SC2016 # a jq program, not shell
CSH_JQ_DEFS='
def clean: tostring | gsub("\\p{Cc}"; " ");
def pad($n): (. + (" " * $n))[0:$n];
def lpad($n): ((" " * $n) + .)[-$n:];
def money: if type != "number" then "" else
  (. * 100 | round) as $c
  | "$" + (($c / 100) | floor | tostring) + "." + ((($c % 100) + 100) | tostring | .[1:]) end;
def tok: if type != "number" then "" elif . >= 1000000 then ((. / 100000 | round) / 10 | tostring) + "M"
  elif . >= 1000 then ((. / 100 | round) / 10 | tostring) + "k" else tostring end;
def day: (. // "") | tostring | .[0:10];
'

# --- notifications ----------------------------------------------------------

# csh_toast <body>: a herdr notification; never fails the caller.
csh_toast() {
  "$CSH_HERDR" notification show claudescope --body "$(printf '%s' "$1" | tr -d '\000-\037\177')" >/dev/null 2>&1 || :
}

# --- locating the CLI -------------------------------------------------------

# csh_expand_home <path>: a leading `~/` becomes $HOME (no other expansion).
csh_expand_home() {
  case $1 in
    \~) printf '%s\n' "$HOME" ;;
    \~/*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# csh_env_value <KEY> <file>: the last `KEY=value` (optionally `export KEY=`)
# in a dotenv file, one level of quotes removed. The file is parsed, never
# sourced, so nothing in it runs. Fails when the key is absent or empty.
csh_env_value() {
  [ -r "$2" ] || return 1
  cev_v=$(sed -n "s/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}$1[[:space:]]*=[[:space:]]*//p" "$2" |
    tail -n 1 |
    sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'\$/\\1/")
  [ -n "$cev_v" ] || return 1
  csh_expand_home "$cev_v"
}

csh_env_file() {
  printf '%s/.env\n' "${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/$CSH_PLUGIN_ID}"
}

# csh_try_dir <dir>: prints <dir>/claudescope when it is an executable file.
csh_try_dir() {
  [ -n "$1" ] && [ -f "$1/claudescope" ] && [ -x "$1/claudescope" ] && printf '%s/claudescope\n' "$1"
}

# csh_find_cli: path of the claudescope executable. herdr's server PATH usually
# lacks fnm/nvm/npm-global dirs, so known install locations are tried after
# PATH. A CLAUDESCOPE_BIN that is set but wrong fails instead of silently
# picking another install.
csh_find_cli() {
  if cfc_v=$(csh_env_value CLAUDESCOPE_BIN "$(csh_env_file)"); then
    if [ -f "$cfc_v" ] && [ -x "$cfc_v" ]; then
      printf '%s\n' "$cfc_v"
      return 0
    fi
    return 1
  fi
  if cfc_v=$(command -v claudescope 2>/dev/null) && [ -n "$cfc_v" ]; then
    printf '%s\n' "$cfc_v"
    return 0
  fi
  cfc_npm=
  if command -v npm >/dev/null 2>&1; then
    cfc_npm=$(npm config get prefix 2>/dev/null) && cfc_npm="$cfc_npm/bin"
  fi
  { [ -n "${FNM_DIR:-}" ] && csh_try_dir "$FNM_DIR/aliases/default/bin"; } ||
    csh_try_dir "${XDG_DATA_HOME:-$HOME/.local/share}/fnm/aliases/default/bin" ||
    csh_try_dir "$HOME/.local/share/fnm/aliases/default/bin" ||
    csh_try_dir "$HOME/Library/Application Support/fnm/aliases/default/bin" ||
    csh_try_dir "$cfc_npm" ||
    csh_try_dir "$HOME/.npm-global/bin" ||
    csh_try_dir "$HOME/.volta/bin" ||
    csh_try_dir /opt/homebrew/bin ||
    csh_try_dir /usr/local/bin ||
    csh_try_dir /home/linuxbrew/.linuxbrew/bin ||
    csh_try_dir "$HOME/.nix-profile/bin" ||
    csh_try_dir "/etc/profiles/per-user/${USER:-}/bin" ||
    csh_try_dir /run/current-system/sw/bin
}

# csh_init: locate the CLI (its directory goes first on PATH so the `node` its
# shebang needs resolves, and the daemon it spawns inherits it), require jq,
# and create this run's temp dir. Toasts and fails when something is missing.
# Callers own the cleanup: `trap csh_cleanup EXIT`.
csh_init() {
  if ! CSH_CLI=$(csh_find_cli); then
    csh_toast "claudescope CLI not found. Set CLAUDESCOPE_BIN=/path/to/claudescope in $(csh_env_file)"
    return 1
  fi
  PATH="$(dirname -- "$CSH_CLI"):$PATH"
  if ci_home=$(csh_env_value CLAUDESCOPE_HOME "$(csh_env_file)"); then
    CLAUDESCOPE_HOME=$ci_home
    export CLAUDESCOPE_HOME
  fi
  export PATH CSH_CLI
  if ! command -v jq >/dev/null 2>&1; then
    csh_toast "The claudescope herdr plugin needs jq. Install it (brew install jq / apt install jq) and retry."
    return 1
  fi
  CSH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/claudescope-herdr.XXXXXX") || {
    csh_toast "claudescope plugin: could not create a temp dir"
    return 1
  }
  export CSH_TMP
}

csh_cleanup() {
  [ -n "${CSH_TMP:-}" ] && rm -rf "$CSH_TMP"
}

# --- the pane the plugin was invoked from -----------------------------------

# csh_source_pane: the pane an action was pressed in. A popup gets it from the
# action as CSH_SRC_PANE; the context JSON's focused pane is the fallback.
csh_source_pane() {
  if [ -n "${CSH_SRC_PANE:-}" ]; then
    printf '%s\n' "$CSH_SRC_PANE"
  elif [ -n "${HERDR_PANE_ID:-}" ]; then
    printf '%s\n' "$HERDR_PANE_ID"
  elif [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ] && command -v jq >/dev/null 2>&1; then
    printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | jq -r '.focused_pane_id // empty | strings' 2>/dev/null
  fi
}

# csh_pane_info <pane-id>: sets CSH_PANE_SESSION (the agent's session id, when
# herdr's integration recorded one) and CSH_PANE_CWD (the foreground process's
# cwd, else the pane's, else the context's).
# shellcheck disable=SC2034 # read by the entry scripts
csh_pane_info() {
  CSH_PANE_SESSION=
  CSH_PANE_CWD=
  if [ -n "$1" ]; then
    cpi_json=$("$CSH_HERDR" pane get "$1" 2>/dev/null) || cpi_json=
    if [ -n "$cpi_json" ]; then
      CSH_PANE_SESSION=$(printf '%s' "$cpi_json" | jq -r '.result.pane.agent_session.value // empty | strings' 2>/dev/null)
      CSH_PANE_CWD=$(printf '%s' "$cpi_json" | jq -r '.result.pane.foreground_cwd // .result.pane.cwd // empty | strings' 2>/dev/null)
    fi
  fi
  if [ -z "$CSH_PANE_CWD" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
    CSH_PANE_CWD=$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | jq -r '.focused_pane_cwd // empty | strings' 2>/dev/null)
  fi
  :
}

# --- talking to claudescope -------------------------------------------------

# csh_live_report <exit-code> <out-file>: interpret a finished `live --json`.
# Prints the live list, or an empty one when the daemon is down (exit 3: toast
# that it is starting, since the next query starts it) or the call failed for
# another reason. Fails only for a daemon that is up but not answering (exit 4).
csh_live_report() {
  case $1 in
    0) cat "$2" ;;
    3)
      csh_toast "starting claudescope…"
      printf '%s\n' '{"sessions":[]}'
      ;;
    4)
      csh_toast "claudescope is not responding (if it stays that way: claudescope restart)"
      return 1
      ;;
    *) printf '%s\n' '{"sessions":[]}' ;;
  esac
}

# csh_live_json: `live --json` (it never starts the daemon); see csh_live_report.
csh_live_json() {
  "$CSH_CLI" live --json >"$CSH_TMP/live.out" 2>/dev/null
  csh_live_report $? "$CSH_TMP/live.out"
}

# csh_resolve_run <session-id> <cwd>: call `resolve --json` (stdout/stderr are
# the caller's). Without either argument there is nothing to resolve.
csh_resolve_run() {
  crr_sid=$1 crr_cwd=$2
  if [ -z "$crr_sid" ] && [ -z "$crr_cwd" ]; then
    printf '%s\n' '{"match":"none","project":null,"sessions":[]}'
    return 0
  fi
  set -- resolve --json
  [ -n "$crr_sid" ] && set -- "$@" "--session=$crr_sid"
  [ -n "$crr_cwd" ] && set -- "$@" "--cwd=$crr_cwd"
  "$CSH_CLI" "$@"
}

# csh_resolve_report <exit-code> <out-file> <err-file>: interpret a finished
# resolve. A CLI that predates the command answers `Unknown command` on stderr
# (a usage error exits 1 too, so the exit code alone can't tell) and gets an
# "upgrade" toast.
csh_resolve_report() {
  if [ "$1" -ne 0 ]; then
    if grep -q 'Unknown command' "$3"; then
      csh_toast "This claudescope is too old for the herdr plugin. Upgrade it: claudescope update"
    else
      csh_toast "claudescope resolve failed: $(head -n 1 "$3" | jq -Rr "$CSH_JQ_DEFS clean" 2>/dev/null)"
    fi
    return 1
  fi
  cat "$2"
}

# csh_resolve <session-id> <cwd>: `resolve --json`.
csh_resolve() {
  csh_resolve_run "$1" "$2" >"$CSH_TMP/resolve.out" 2>"$CSH_TMP/resolve.err"
  csh_resolve_report $? "$CSH_TMP/resolve.out" "$CSH_TMP/resolve.err"
}

# csh_live_and_resolve <session-id> <cwd>: the two independent startup calls
# run concurrently (each costs a node start); both are waited for. Sets
# CSH_LIVE (the live JSON) and CSH_RESOLVE (the resolve JSON), toasting exactly
# as csh_live_json and csh_resolve do. Fails when either did.
# shellcheck disable=SC2034 # read by the entry scripts
csh_live_and_resolve() {
  clr_sid=$1 clr_cwd=$2
  "$CSH_CLI" live --json >"$CSH_TMP/live.out" 2>/dev/null &
  clr_live_pid=$!
  csh_resolve_run "$clr_sid" "$clr_cwd" >"$CSH_TMP/resolve.out" 2>"$CSH_TMP/resolve.err" &
  clr_res_pid=$!
  wait "$clr_live_pid"
  clr_live_rc=$?
  wait "$clr_res_pid"
  clr_res_rc=$?
  CSH_LIVE=$(csh_live_report "$clr_live_rc" "$CSH_TMP/live.out") || return 1
  CSH_RESOLVE=$(csh_resolve_report "$clr_res_rc" "$CSH_TMP/resolve.out" "$CSH_TMP/resolve.err") || return 1
}

# csh_loading / csh_loaded: a one-line "loading…" for a popup that is about to
# spend a few hundred milliseconds on CLI calls; csh_loaded erases it (only a
# terminal gets the erase sequence).
csh_loading() {
  printf '  loading…'
}
csh_loaded() {
  if [ -t 1 ]; then printf '\r\033[2K'; else printf '\n'; fi
}

# csh_url [session-id]: the daemon's loopback URL (of one session), read from
# its daemon.json. `claudescope open` prints nothing, and over SSH the browser
# can't open, so the toast carries the URL.
csh_url() {
  cu_home=$(csh_expand_home "${CLAUDESCOPE_HOME:-$HOME/.claudescope}")
  cu_port=$(jq -r '.port | select(type == "number" and . == floor and . >= 1 and . <= 65535)' \
    "$cu_home/daemon.json" 2>/dev/null) || return 1
  [ -n "$cu_port" ] || return 1
  if [ -n "${1:-}" ]; then
    printf 'http://127.0.0.1:%s/sessions/%s\n' "$cu_port" "$(jq -rn --arg id "$1" '$id | @uri')"
  else
    printf 'http://127.0.0.1:%s\n' "$cu_port"
  fi
}

# csh_open_session <id> <display title> [prefix]: open in the browser, then
# toast the title and URL.
csh_open_session() {
  if ! "$CSH_CLI" open "--session=$1" >/dev/null 2>&1; then
    csh_toast "claudescope could not open session $1"
    return 1
  fi
  cos_url=$(csh_url "$1") || cos_url=
  csh_toast "${3:-}$2${cos_url:+ — $cos_url}"
}

# csh_is_live <id>: whether the id is in this run's live list.
csh_is_live() {
  [ -r "$CSH_TMP/live.json" ] && jq -e --arg id "$1" 'index([$id]) != null' "$CSH_TMP/live.json" >/dev/null 2>&1
}

# csh_save_live <live-json>: keep the live ids for row marks and confirmations.
csh_save_live() {
  printf '%s' "$1" | jq '[.sessions[]?.meta.id | strings]' >"$CSH_TMP/live.json" 2>/dev/null ||
    printf '[]\n' >"$CSH_TMP/live.json"
}

# --- picker rows ------------------------------------------------------------
# A row is tab-delimited with the session id in field 1, then: live mark,
# agent, date, cost, title (· snippet for search hits). fzf hides field 1.

# shellcheck disable=SC2016 # a jq program, not shell
CSH_JQ_ROW='
  ($l[0] // [] | map({(.): true}) | add // {}) as $live
  | def row($id; $title): [($id | clean), (if $live[$id] then "●" else " " end),
      (.connectorId // "" | clean | pad(12)), (.endedAt | day | pad(10)),
      (.totalCostUsd | money | lpad(8)), $title] | join("\t");'

# csh_rows_sessions: SessionMeta[] on stdin → rows.
csh_rows_sessions() {
  [ -r "$CSH_TMP/live.json" ] || printf '[]\n' >"$CSH_TMP/live.json"
  jq -r --slurpfile l "$CSH_TMP/live.json" "$CSH_JQ_DEFS $CSH_JQ_ROW"'
    .[]? | row(.id; (.title // "" | clean))'
}

# csh_rows_search: SearchResponse on stdin → rows, one per session (first,
# i.e. best-ranked, hit wins).
csh_rows_search() {
  [ -r "$CSH_TMP/live.json" ] || printf '[]\n' >"$CSH_TMP/live.json"
  jq -r --slurpfile l "$CSH_TMP/live.json" "$CSH_JQ_DEFS $CSH_JQ_ROW"'
    reduce (.sessions // [])[] as $h ({seen: {}, out: []};
      if .seen[$h.sessionId] then . else .seen[$h.sessionId] = true | .out += [$h] end)
    | .out[] | row(.sessionId; ((.title // "" | clean) + "  · " + (.snippet // "" | clean | .[0:160])))'
}

# csh_scope: `project` or `all` (fzf's Tab and the list's `/` switch it).
csh_scope() {
  if [ -n "${CSH_PROJECT:-}" ] && [ "$(cat "$CSH_TMP/scope" 2>/dev/null)" != all ]; then
    printf 'project\n'
  else
    printf 'all\n'
  fi
}

# csh_rows <query>: rows for the picker. Empty query → the scope's sessions,
# newest first; otherwise full-text search hits.
csh_rows() {
  if [ "$(csh_scope)" = project ]; then
    set -- "$1" "--project=$CSH_PROJECT"
  fi
  case $1 in
    *[![:space:]]*)
      cr_q=$1
      shift
      "$CSH_CLI" search "$@" --json -- "$cr_q" 2>/dev/null | csh_rows_search
      ;;
    *)
      shift
      "$CSH_CLI" sessions "$@" --limit 100 --json 2>/dev/null | csh_rows_sessions
      ;;
  esac
}

# csh_preview <id>: the session's last turns, control characters stripped
# (tabs and newlines kept).
csh_preview() {
  [ -n "$1" ] || return 0
  "$CSH_CLI" session --tail 8 -- "$1" 2>&1 | jq -Rr 'gsub("[^\\P{Cc}\t]"; "")'
}

# --- resume / fork into a split ---------------------------------------------

# csh_confirm <question>: y/Y on stdin (the popup's terminal) → success.
csh_confirm() {
  printf '%s [y/N] ' "$1"
  IFS= read -r cc_ans || cc_ans=
  case $cc_ans in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# csh_resume <id> <resume|fork> <source-pane>: open the agent's resume (or
# fork) command in a new split to the right of the source pane, in the
# session's cwd. Returns 0 when the command was started, 1 after a toast (no
# resume command, no fork, vanished cwd, herdr failure) or a declined prompt.
csh_resume() {
  if ! crs_json=$("$CSH_CLI" session --tail 1 --json -- "$1" 2>/dev/null); then
    csh_toast "claudescope could not load session $1"
    return 1
  fi
  printf '%s' "$crs_json" >"$CSH_TMP/session.json"
  crs_agent=$(jq -r "$CSH_JQ_DEFS"' .meta.connectorId // "this agent" | clean' "$CSH_TMP/session.json")
  crs_cwd=$(jq -r '.resume.cwd // empty | strings' "$CSH_TMP/session.json")
  if [ "$2" = fork ]; then
    crs_cmd=$(jq -r '.resume.forkCommand // empty | strings' "$CSH_TMP/session.json")
  else
    crs_cmd=$(jq -r '.resume.resumeCommand // empty | strings' "$CSH_TMP/session.json")
  fi
  if [ -z "$crs_cwd" ] || ! jq -e '.resume.resumeCommand | strings' "$CSH_TMP/session.json" >/dev/null 2>&1; then
    csh_toast "No resume command for this $crs_agent session"
    return 1
  fi
  if [ -z "$crs_cmd" ]; then
    csh_toast "$crs_agent has no fork command; Enter resumes the session instead"
    return 1
  fi
  # herdr types the command into a shell: a control character (^U, ^W, ESC,
  # CR…) would act as a line-editor command instead of text.
  case $crs_cmd$crs_cwd in
    *[[:cntrl:]]*)
      csh_toast "The $crs_agent resume command or folder contains control characters; not running it"
      return 1
      ;;
  esac
  if [ ! -d "$crs_cwd" ]; then
    csh_toast "The session's folder no longer exists: $(printf '%s' "$crs_cwd" | jq -Rr "$CSH_JQ_DEFS clean")"
    return 1
  fi
  if [ "$2" != fork ] && csh_is_live "$1"; then
    csh_confirm "This session is live: an agent may still be writing to it, and resuming adds a second writer. Resume anyway?" ||
      return 1
  fi
  crs_new=$("$CSH_HERDR" pane split "$3" --direction right "--cwd=$crs_cwd" --focus 2>/dev/null |
    jq -r '.result.pane.pane_id // empty | strings' 2>/dev/null)
  if [ -z "$crs_new" ]; then
    csh_toast "herdr could not split the pane"
    return 1
  fi
  # One argv element: herdr types it into the new pane's shell, which parses it.
  if ! "$CSH_HERDR" pane run "$crs_new" "$crs_cmd" >/dev/null 2>&1; then
    csh_toast "herdr could not run the resume command"
    return 1
  fi
}

# --- misc -------------------------------------------------------------------

# csh_date_ago <n>: the local date n days ago. jq does the calendar math (no
# GNU/BSD date split; busybox date has neither -d nor -v), anchored at local
# noon so a DST change can't shift the day.
csh_date_ago() {
  jq -nr --argjson n "$1" \
    'now | localtime | .[3] = 12 | .[4] = 0 | .[5] = 0 | mktime - ($n * 86400) | strftime("%Y-%m-%d")'
}

# csh_read_key: one keypress on a terminal, else one line of stdin (q at EOF,
# also on a terminal that hit EOF: dd reads nothing, while Enter reads a newline).
csh_read_key() {
  if [ -t 0 ]; then
    crk_old=$(stty -g)
    stty -icanon -echo min 1 time 0
    crk_key=$(dd bs=1 count=1 2>/dev/null; printf x)
    stty "$crk_old"
    crk_key=${crk_key%x}
    [ -n "$crk_key" ] || crk_key=q
    crk_key=$(printf '%s' "$crk_key" | tr -d '\n')
  else
    IFS= read -r crk_key || crk_key=q
  fi
  printf '%s\n' "$crk_key"
}

# csh_wait_close: hold a popup until a key, so a message stays readable.
csh_wait_close() {
  printf '\n  press any key to close'
  csh_read_key >/dev/null
}

# --- numbered-list fallback (no fzf) ----------------------------------------

CSH_TAB=$(printf '\t')

# csh_print_rows <rows-file> <max>: rows numbered from 1, field 1 hidden.
csh_print_rows() {
  cpr_n=0
  while IFS= read -r cpr_line; do
    cpr_n=$((cpr_n + 1))
    [ "$cpr_n" -le "$2" ] || continue
    printf '%3d  %s\n' "$cpr_n" "$(printf '%s' "$cpr_line" | cut -f 2- | tr '\t' ' ')"
  done <"$1"
  if [ "$cpr_n" -eq 0 ]; then
    printf '     No sessions match.\n'
  elif [ "$cpr_n" -gt "$2" ]; then
    printf '     … %s more (narrow with /text)\n' "$((cpr_n - $2))"
  fi
}

# csh_row_at <rows-file> <n>: row n, failing for a non-number or a missing row.
csh_row_at() {
  case $2 in '' | *[!0-9]*) return 1 ;; esac
  cra_line=$(sed -n "$2p" "$1")
  [ -n "$cra_line" ] && printf '%s\n' "$cra_line"
}

# csh_row_id / csh_row_title <row>: field 1 (session id) / field 6 (title).
csh_row_id() { printf '%s\n' "${1%%"$CSH_TAB"*}"; }
csh_row_title() { printf '%s' "$1" | cut -f 6 | jq -Rr '.[0:80]'; }

# csh_prompt: the picker prompt, naming the scope.
csh_prompt() {
  if [ "$(csh_scope)" = project ]; then
    printf '%s> ' "${CSH_PROJECT_NAME:-project}"
  else
    printf 'all projects> '
  fi
}
