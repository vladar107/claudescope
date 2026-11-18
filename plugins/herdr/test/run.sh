#!/bin/sh
# Headless tests for the herdr plugin: every script runs against stub
# `claudescope`, `herdr`, and `fzf` executables in a sandbox (fresh HOME,
# CLAUDESCOPE_HOME, herdr config/state dirs, and a PATH holding only the basic
# tools), so neither the real herdr nor the real claudescope is ever called.
# The stubs log argv one <element> per argument; the assertions read that log.
#
# Usage: sh plugins/herdr/test/run.sh   (TEST_SHELLS="sh dash" to choose shells)
set -u

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname -- "$HERE")
FIXTURES=$HERE/fixtures

A=11111111-1111-4111-8111-111111111111
B=22222222-2222-4222-8222-222222222222
C=33333333-3333-4333-8333-333333333333
D=44444444-4444-4444-8444-444444444444

date_ago() {
  if [ "$1" -eq 0 ]; then
    date +%Y-%m-%d
  else
    date -d "-$1 days" +%Y-%m-%d 2>/dev/null || date -v "-$1d" +%Y-%m-%d
  fi
}

fails=0
passes=0

pass() { passes=$((passes + 1)); }
fail() {
  fails=$((fails + 1))
  printf '  FAIL [%s] %s\n' "$CASE" "$1"
  printf '    log:\n'
  sed 's/^/      /' "$STUB_LOG" 2>/dev/null
  [ -s "$T/out" ] && { printf '    output:\n'; sed 's/^/      /' "$T/out"; }
}

# expect / reject <fixed string>: is it in the stub log?
expect() { if grep -qF -- "$1" "$STUB_LOG"; then pass; else fail "expected in log: $1"; fi; }
reject() { if grep -qF -- "$1" "$STUB_LOG"; then fail "unexpected in log: $1"; else pass; fi; }
expect_out() { if grep -qF -- "$1" "$T/out"; then pass; else fail "expected in output: $1"; fi; }
reject_out() { if grep -qF -- "$1" "$T/out"; then fail "unexpected in output: $1"; else pass; fi; }

# sandbox <shell>: a fresh temp tree, tools dir, and stub dirs.
sandbox() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/csh-herdr-test.XXXXXX")
  mkdir -p "$T/tools" "$T/cs" "$T/herdr" "$T/fzf" "$T/home" "$T/cshome" "$T/config" "$T/state" "$T/tmp" "$T/app/src"
  for tool in cat sed grep tr head tail cut mktemp rm mkdir mv cp date dirname basename dd stty env wc sort ls sleep; do
    p=$(command -v "$tool") && ln -s "$p" "$T/tools/$tool"
  done
  ln -s "$(command -v "$1")" "$T/tools/sh"
  JQ=$(command -v jq)
  cp "$HERE/stubs/claudescope" "$T/cs/claudescope"
  cp "$HERE/stubs/herdr" "$T/herdr/herdr"
  cp "$HERE/stubs/fzf" "$T/fzf/fzf"
  printf '{"pid":1,"port":4317,"url":"http://127.0.0.1:4317","version":"0.0.0","startedAt":"x"}\n' >"$T/cshome/daemon.json"
  printf '# plugin config\nexport CLAUDESCOPE_BIN="%s"\n' "$T/cs/claudescope" >"$T/config/.env"
  STUB_LOG=$T/log
  STUB_D0=$(date_ago 0) STUB_D3=$(date_ago 3) STUB_D6=$(date_ago 6) STUB_D20=$(date_ago 20) STUB_D29=$(date_ago 29)
}

# new_case <name>: reset the log, the output, and every per-case knob.
new_case() {
  CASE=$1
  : >"$STUB_LOG"
  : >"$T/out"
  : >"$T/answers"
  rm -f "$T/state"/pick.*
  STUB_MATCH=id STUB_PANE=agent STUB_LIVE_EXIT=0 STUB_UNKNOWN=''
  STUB_FZF_VERSION='' STUB_SESSIONS='' STUB_K7='' RUN_TZ=''
  WITH_JQ=1 WITH_FZF=1 CSH_SRC_PANE='' HERDR_PANE_ID=w1:p1 CSH_PICK_FILE=''
  STUB_DELAY='' STUB_BARRIER='' STUB_RELOAD_FAIL=''
  CFG=$T/hconf/config.toml
  rm -rf "$T/home/.local" "$T/home/.config/herdr"
  chmod -R u+w "$T/hconf" 2>/dev/null
  rm -rf "$T/hconf" "$T/dots" "$T/bar"* "$T/state/config.toml.bak"
  printf '# plugin config\nexport CLAUDESCOPE_BIN="%s"\n' "$T/cs/claudescope" >"$T/config/.env"
}

# barrier_met <dir>: no command of the STUB_BARRIER rendezvous timed out.
barrier_met() { if [ -e "$1.failed" ]; then fail "calls were not concurrent"; else pass; fi; }

# count_log <fixed string>: how many log lines contain it.
count_log() { grep -cF -- "$1" "$STUB_LOG"; }

# cfg_has / cfg_lacks <fixed string>: is it in the herdr config under test?
cfg_has() { if grep -qF -- "$1" "$CFG"; then pass; else fail "expected in config: $1"; fi; }
cfg_lacks() { if grep -qF -- "$1" "$CFG"; then fail "unexpected in config: $1"; else pass; fi; }

# run_env <command…>: the command in the scrubbed plugin environment.
run_env() {
  env -i ${RUN_TZ:+"TZ=$RUN_TZ"} \
    STUB_FZF_VERSION="$STUB_FZF_VERSION" STUB_SESSIONS="$STUB_SESSIONS" STUB_K7="$STUB_K7" \
    HOME="$T/home" PATH="$T/tools" TMPDIR="$T/tmp" TERM=dumb \
    CLAUDESCOPE_HOME="$T/cshome" \
    HERDR_BIN_PATH="$T/herdr/herdr" HERDR_PLUGIN_ID=claudescope HERDR_PLUGIN_ROOT="$ROOT" \
    HERDR_PLUGIN_CONFIG_DIR="$T/config" HERDR_PLUGIN_STATE_DIR="$T/state" \
    HERDR_PLUGIN_CONTEXT_JSON="$(cat "$FIXTURES/context.json")" \
    HERDR_PANE_ID="$HERDR_PANE_ID" CSH_SRC_PANE="$CSH_SRC_PANE" CSH_PICK_FILE="$CSH_PICK_FILE" \
    STUB_LOG="$STUB_LOG" STUB_FIXTURES="$FIXTURES" STUB_APP_DIR="$T/app" STUB_FZF_ANSWERS="$T/answers" \
    STUB_MATCH="$STUB_MATCH" STUB_PANE="$STUB_PANE" STUB_LIVE_EXIT="$STUB_LIVE_EXIT" STUB_UNKNOWN="$STUB_UNKNOWN" \
    STUB_DELAY="$STUB_DELAY" STUB_BARRIER="$STUB_BARRIER" HERDR_CONFIG_PATH="$CFG" \
    STUB_D0="$STUB_D0" STUB_D3="$STUB_D3" STUB_D6="$STUB_D6" STUB_D20="$STUB_D20" STUB_D29="$STUB_D29" \
    "$@"
}

# run <script> [args…] < stdin: one plugin script in a scrubbed environment.
run() {
  rm -f "$T/tools/jq" "$T/tools/fzf"
  [ "$WITH_JQ" = 1 ] && ln -s "$JQ" "$T/tools/jq"
  [ "$WITH_FZF" = 1 ] && ln -s "$T/fzf/fzf" "$T/tools/fzf"
  rs_script=$1
  shift
  run_env "$T/tools/sh" "$ROOT/bin/$rs_script" "$@" >"$T/out" 2>&1
}

# run_build: install-keys.sh --build the way herdr runs a [[build]]
# command: no HERDR_* variables at all (HERDR_CONFIG_PATH aside, the test
# hook), the stub herdr only reachable as `herdr` on PATH.
run_build() {
  rm -f "$T/tools/jq" "$T/tools/fzf"
  ln -s "$JQ" "$T/tools/jq"
  ln -sf "$T/herdr/herdr" "$T/tools/herdr"
  env -i HOME="$T/home" PATH="$T/tools" TMPDIR="$T/tmp" TERM=dumb \
    STUB_LOG="$STUB_LOG" STUB_FIXTURES="$FIXTURES" HERDR_CONFIG_PATH="$CFG" \
    STUB_RELOAD_FAIL="$STUB_RELOAD_FAIL" \
    "$T/tools/sh" "$ROOT/bin/install-keys.sh" --build >"$T/out" 2>&1
  rb_rc=$?
  rm -f "$T/tools/herdr"
  return $rb_rc
}

answers() { printf '%s\n' "$@" >"$T/answers"; }

URL=http://127.0.0.1:4317/sessions

suite() {
  printf '%s\n' "== shell: $1"
  sandbox "$1"

  # --- open-session -----------------------------------------------------------
  new_case open-id
  run open-session.sh </dev/null
  expect "claudescope <live> <--json>"
  expect "claudescope <resolve> <--json> <--session=$A> <--cwd=$T/app/src>"
  expect "claudescope <open> <--session=$A>"
  expect "herdr <notification> <show> <claudescope> <--body> <Fix login redirect — $URL/$A>"
  reject "starting claudescope"

  new_case open-live-shell-pane
  STUB_MATCH=live STUB_PANE=shell
  run open-session.sh </dev/null
  expect "claudescope <resolve> <--json> <--cwd=$T/app/src>"
  reject "<resolve> <--json> <--session="
  expect "claudescope <open> <--session=$A>"
  expect "<--body> <Fix login redirect — $URL/$A>"

  new_case open-recent
  STUB_MATCH=recent
  run open-session.sh </dev/null
  expect "claudescope <open> <--session=$B>"
  # the ESC/BEL of the fixture title are gone from the toast
  expect "<--body> <Matched by folder (no live session here): Add retry to uploader ]0;pwned  — $URL/$B>"

  new_case open-none
  STUB_MATCH=none
  run open-session.sh </dev/null
  reject "<open>"
  expect "<--body> <No claudescope session for this pane ($T/app/src)>"

  new_case open-ambiguous
  STUB_MATCH=ambiguous
  run open-session.sh </dev/null
  reject "claudescope <open>"
  expect "herdr <plugin> <pane> <open> <--plugin> <claudescope> <--entrypoint> <pick> <--env> <CSH_PICK_FILE=$T/state/pick."
  expect "<--env> <CSH_SRC_PANE=w1:p1>"
  pick_file=
  for f in "$T/state"/pick.*; do [ -f "$f" ] && pick_file=$f; done
  if [ -n "$pick_file" ] && "$JQ" -e '.match == "ambiguous" and (.sessions | length) == 2' "$pick_file" >/dev/null; then pass; else fail "pick file with both candidates"; fi

  new_case pick-fzf
  cp "$FIXTURES/resolve-ambiguous.json" "$T/state/pick.test"
  CSH_PICK_FILE=$T/state/pick.test
  answers "|$B"
  run pick.sh </dev/null
  expect "claudescope <open> <--session=$B>"
  expect "<--preview=sh \"\$CSH_BIN/fzf-helper.sh\" preview {1}>"
  if [ -e "$T/state/pick.test" ]; then fail "pick file deleted after reading"; else pass; fi

  new_case pick-numbered
  WITH_FZF=0
  cp "$FIXTURES/resolve-ambiguous.json" "$T/state/pick.test"
  CSH_PICK_FILE=$T/state/pick.test
  printf '7\n2\n' | run pick.sh
  expect_out "No row 7."
  expect "claudescope <open> <--session=$B>"
  reject "<open> <--session=$A>"

  new_case pick-stale-recorded-session
  cp "$FIXTURES/resolve-stale.json" "$T/state/pick.test"
  CSH_PICK_FILE=$T/state/pick.test
  answers "|$B"
  run pick.sh </dev/null
  expect "<--header=Which session is this pane? in /home/user/src/app"
  reject "Live sessions"
  new_case pick-stale-recorded-session-numbered
  WITH_FZF=0
  cp "$FIXTURES/resolve-stale.json" "$T/state/pick.test"
  CSH_PICK_FILE=$T/state/pick.test
  printf 'q\n' | run pick.sh
  expect_out "which session is this pane? in /home/user/src/app"
  expect_out "this pane's recorded session (not live) · Stale pane session"
  first=$(grep -n 'Fix login redirect' "$T/out" | head -n 1 | cut -d: -f1)
  second=$(grep -n 'Stale pane session' "$T/out" | head -n 1 | cut -d: -f1)
  if [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]; then pass; else fail "live rows first"; fi
  new_case pick-live-header-unchanged
  cp "$FIXTURES/resolve-ambiguous.json" "$T/state/pick.test"
  CSH_PICK_FILE=$T/state/pick.test
  answers "|$B"
  run pick.sh </dev/null
  expect "<--header=Live sessions in /home/user/src/app"

  new_case pick-file-removed-when-init-fails
  WITH_JQ=0
  cp "$FIXTURES/resolve-ambiguous.json" "$T/state/pick.test"
  CSH_PICK_FILE=$T/state/pick.test
  run pick.sh </dev/null
  expect "<--body> <The claudescope herdr plugin needs jq."
  if [ -e "$T/state/pick.test" ]; then fail "pick file deleted when init fails"; else pass; fi

  new_case cold-daemon
  STUB_LIVE_EXIT=3
  run open-session.sh </dev/null
  expect "<--body> <starting claudescope…>"
  expect "claudescope <open> <--session=$A>"
  if [ "$(grep -n 'starting claudescope' "$STUB_LOG" | cut -d: -f1)" -lt "$(grep -n '<resolve>' "$STUB_LOG" | cut -d: -f1)" ]; then pass; else fail "starting toast before resolve"; fi

  new_case wedged-daemon
  STUB_LIVE_EXIT=4
  run open-session.sh </dev/null
  expect "<--body> <claudescope is not responding"
  reject "<resolve>"

  new_case old-cli
  STUB_UNKNOWN=1
  run open-session.sh </dev/null
  expect "<--body> <This claudescope is too old for the herdr plugin. Upgrade it: claudescope update>"
  reject "claudescope <open>"

  new_case missing-jq
  WITH_JQ=0
  run open-session.sh </dev/null
  expect "herdr <notification> <show> <claudescope> <--body> <The claudescope herdr plugin needs jq."
  reject "claudescope <"

  new_case cli-not-found
  printf 'CLAUDESCOPE_BIN=%s/nowhere/claudescope\n' "$T" >"$T/config/.env"
  run open-session.sh </dev/null
  expect "<--body> <claudescope CLI not found. Set CLAUDESCOPE_BIN=/path/to/claudescope in $T/config/.env>"
  printf '# plugin config\nexport CLAUDESCOPE_BIN="%s"\n' "$T/cs/claudescope" >"$T/config/.env"

  # --- action → popup ------------------------------------------------------------
  new_case open-pane
  run open-pane.sh search </dev/null
  expect "herdr <plugin> <pane> <open> <--plugin> <claudescope> <--entrypoint> <search> <--env> <CSH_SRC_PANE=w1:p1>"

  # --- search popup with fzf ---------------------------------------------------
  new_case search-resume
  CSH_SRC_PANE=w1:p1 HERDR_PANE_ID=''
  answers "|$B"
  run search.sh </dev/null
  expect "claudescope <sessions> <--project=-home-user-src-app> <--limit> <100> <--json>"
  expect "claudescope <session> <--tail> <1> <--json> <--> <$B>"
  expect "herdr <pane> <split> <w1:p1> <--direction> <right> <--cwd=$T/app> <--focus>"
  # resumeCommand reaches herdr as ONE argv element
  expect "herdr <pane> <run> <w1:p9> <cd $T/app && codex resume $B>"
  expect "<--bind=change:reload(sh \"\$CSH_BIN/fzf-helper.sh\" rows {q})>"
  expect "<--bind=tab:execute-silent(sh \"\$CSH_BIN/fzf-helper.sh\" toggle)+reload(sh \"\$CSH_BIN/fzf-helper.sh\" rows {q})+transform-prompt(sh \"\$CSH_BIN/fzf-helper.sh\" prompt)>"
  expect "<--disabled>"
  expect "<--prompt=app> >"

  new_case search-fork-no-fork
  CSH_SRC_PANE=w1:p1
  answers "ctrl-f|$B"
  run search.sh </dev/null
  expect "<--body> <codex has no fork command; Enter resumes the session instead>"
  reject "<split>"

  new_case search-fork
  CSH_SRC_PANE=w1:p1
  answers "ctrl-f|$A"
  run search.sh </dev/null
  expect "herdr <pane> <run> <w1:p9> <cd $T/app && claude --resume $A --fork-session>"
  reject_out "live"

  new_case search-live-declined
  CSH_SRC_PANE=w1:p1
  answers "|$A"
  printf 'n\n' | run search.sh
  expect_out "This session is live"
  reject "<split>"

  new_case search-live-confirmed
  CSH_SRC_PANE=w1:p1
  answers "|$A"
  printf 'y\n' | run search.sh
  expect "herdr <pane> <run> <w1:p9> <cd $T/app && claude --resume $A>"

  new_case search-open
  CSH_SRC_PANE=w1:p1
  answers "ctrl-o|$C"
  run search.sh </dev/null
  expect "claudescope <open> <--session=$C>"
  expect "<--body> <Tidy CI config — $URL/$C>"

  new_case search-no-resume-then-vanished
  CSH_SRC_PANE=w1:p1
  answers "|$C" "|$D"
  run search.sh </dev/null
  expect "<--body> <No resume command for this junie session>"
  expect "<--body> <The session's folder no longer exists: /home/user/src/gone>"
  reject "<split>"

  new_case search-control-chars-cwd
  CSH_SRC_PANE=w1:p1
  answers "|55555555-5555-4555-8555-555555555555"
  run search.sh </dev/null
  expect "<--body> <The claude-code resume command or folder contains control characters; not running it>"
  reject "<split>"
  reject "<run>"

  new_case search-control-chars-command
  CSH_SRC_PANE=w1:p1
  answers "|66666666-6666-4666-8666-666666666666"
  run search.sh </dev/null
  expect "<--body> <The claude-code resume command or folder contains control characters; not running it>"
  reject "<split>"
  reject "<run>"

  new_case search-old-fzf
  CSH_SRC_PANE=w1:p1 STUB_FZF_VERSION=0.35.1
  printf 'q\n' | run search.sh
  expect "<--body> <fzf 0.35 is too old (0.36+ needed); using the numbered list>"
  expect_out "n resume · f<n> fork"
  reject "fzf <--delimiter"

  # --- fzf callbacks -------------------------------------------------------------
  new_case helper-rows
  mkdir -p "$T/tmp/h"
  printf '["%s"]\n' "$A" >"$T/tmp/h/live.json"
  printf 'project\n' >"$T/tmp/h/scope"
  env -i PATH="$T/tools:$T/cs" CSH_CLI="$T/cs/claudescope" CSH_TMP="$T/tmp/h" CSH_PROJECT=-home-user-src-app \
    STUB_LOG="$STUB_LOG" STUB_FIXTURES="$FIXTURES" STUB_D3="$STUB_D3" \
    "$T/tools/sh" "$ROOT/bin/fzf-helper.sh" rows '-x retry' >"$T/out" 2>&1
  expect "claudescope <search> <--project=-home-user-src-app> <--json> <--> <-x retry>"
  if [ "$(wc -l <"$T/out")" -eq 2 ]; then pass; else fail "search hits de-duped by session (2 rows)"; fi
  if [ "$(cut -f 1 "$T/out" | tr '\n' ' ')" = "$B $A " ]; then pass; else fail "session id in field 1, rank order kept"; fi
  if grep -q "$(printf '\033')" "$T/out"; then fail "escape stripped from rows"; else pass; fi
  if [ "$(head -n 1 "$T/out" | tr -cd '\t' | wc -c | tr -d ' ')" -eq 5 ]; then pass; else fail "6 tab-separated fields (snippet tab stripped)"; fi
  if [ "$(sed -n 2p "$T/out" | cut -f 2)" = "●" ]; then pass; else fail "live session marked"; fi

  : >"$STUB_LOG"
  env -i PATH="$T/tools:$T/cs" CSH_CLI="$T/cs/claudescope" CSH_TMP="$T/tmp/h" CSH_PROJECT=-home-user-src-app \
    STUB_LOG="$STUB_LOG" "$T/tools/sh" "$ROOT/bin/fzf-helper.sh" toggle
  env -i PATH="$T/tools:$T/cs" CSH_CLI="$T/cs/claudescope" CSH_TMP="$T/tmp/h" CSH_PROJECT=-home-user-src-app \
    STUB_LOG="$STUB_LOG" STUB_FIXTURES="$FIXTURES" \
    "$T/tools/sh" "$ROOT/bin/fzf-helper.sh" rows '' >"$T/out" 2>&1
  expect "claudescope <sessions> <--limit> <100> <--json>"
  reject "--project"

  env -i PATH="$T/tools:$T/cs" CSH_CLI="$T/cs/claudescope" CSH_TMP="$T/tmp/h" \
    STUB_LOG="$STUB_LOG" "$T/tools/sh" "$ROOT/bin/fzf-helper.sh" preview "$A" >"$T/out" 2>&1
  expect "claudescope <session> <--tail> <8> <--> <$A>"
  if grep -q "$(printf '\033')" "$T/out" || grep -q "$(printf '\007')" "$T/out"; then fail "preview control chars stripped"; else pass; fi
  expect_out "$(printf 'hello [31mred[0m\ttabbed')"

  # --- search popup without fzf -------------------------------------------------
  new_case search-numbered
  WITH_FZF=0 CSH_SRC_PANE=w1:p1
  printf 'f2\no9\n/retry\n1\n' | run search.sh
  expect_out "claudescope · app (/home/user/src/app)"
  expect_out "n resume · f<n> fork · o<n> open · /text search all · / this project · q quit"
  expect_out "codex"
  reject_out "$(printf '\033')"
  expect "<--body> <codex has no fork command; Enter resumes the session instead>"
  expect_out "No row 9."
  expect "claudescope <search> <--json> <--> <retry>"
  expect_out 'claudescope · all projects · "retry"'
  expect "herdr <pane> <run> <w1:p9> <cd $T/app && codex resume $B>"

  new_case search-numbered-quit
  WITH_FZF=0 CSH_SRC_PANE=w1:p1
  printf 'q\n' | run search.sh
  reject "<split>"
  reject "<open>"

  new_case row-title-multibyte
  a79=$(printf '%079d' 0 | tr 0 a)
  # shellcheck disable=SC2016 # literal $ in the cost column
  row=$(printf 'id\t \tcodex\t2026-01-01\t$1.00\t%sééé' "$a79")
  # shellcheck disable=SC2016 # expanded by the inner sh
  title=$(env -i PATH="$T/tools:$(dirname "$JQ")" "$T/tools/sh" -c '. "$1/bin/lib.sh"; csh_row_title "$2"' x "$ROOT" "$row")
  if [ "$title" = "${a79}é" ]; then pass; else fail "title cut at 80 characters, not bytes: $title"; fi

  # --- cost popup ---------------------------------------------------------------
  new_case cost
  printf 'q\n' | run cost.sh
  expect "claudescope <analytics> <--group-by> <project> <--project=-home-user-src-app> <--from=$STUB_D0> <--json>"
  expect "claudescope <analytics> <--group-by> <project> <--project=-home-user-src-app> <--from=$STUB_D6> <--json>"
  expect "claudescope <analytics> <--group-by> <project> <--project=-home-user-src-app> <--from=$STUB_D29> <--json>"
  expect "claudescope <sessions> <--project=-home-user-src-app> <--sort> <recent> <--limit> <200> <--json>"
  expect_out "Today            \$1.25   150k tokens · 12 responses"
  expect_out "Last 7 days      \$8.40   2.1M tokens · 90 responses"
  expect_out "Last 30 days    \$31.00   9.8M tokens · 410 responses"
  expect_out "This pane    Fix login redirect"
  expect_out "\$2.10 · 1.2M tokens · 48 messages"
  reject_out "Big refactor last month"
  reject_out "$(printf '\033')"
  first=$(grep -n 'Add retry to uploader' "$T/out" | head -n 1 | cut -d: -f1)
  second=$(grep -n 'Fix login redirect' "$T/out" | tail -n 1 | cut -d: -f1)
  if [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]; then pass; else fail "top sessions sorted by cost"; fi
  reject "claudescope <open>"

  new_case cost-stale-id-counts-live-only
  STUB_MATCH=stale
  printf 'q\n' | run cost.sh
  expect_out "This pane    1 live sessions in this folder"

  new_case cost-tty-eof-exits
  if [ -x /usr/bin/python3 ] || command -v python3 >/dev/null 2>&1; then
    py=$(command -v python3)
    tty_out=$(run_env "$py" -I -c '
import os, pty, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    os.execv(sys.argv[1], sys.argv[1:])
deadline = time.time() + 5
buf = b""
while b"q close" not in buf and time.time() < deadline:
    try:
        buf += os.read(fd, 4096)
    except OSError:
        break
os.close(fd)
deadline = time.time() + 8
while time.time() < deadline:
    done, _ = os.waitpid(pid, os.WNOHANG)
    if done:
        print("exited")
        sys.exit(0)
    time.sleep(0.1)
os.kill(pid, signal.SIGKILL)
print("hung")
sys.exit(1)
' "$T/tools/sh" "$ROOT/bin/cost.sh" 2>&1)
    if [ "$tty_out" = exited ]; then pass; else fail "cost popup exits when the terminal hits EOF: $tty_out"; fi
  fi

  new_case cost-no-date-tool
  rm -f "$T/tools/date"
  # shellcheck disable=SC2016 # script text, not expanded here
  printf '#!/bin/sh\n[ "$1" = +%%Y-%%m-%%d ] && exec /bin/date "$@"\nexit 1\n' >"$T/tools/date"
  chmod +x "$T/tools/date"
  printf 'q\n' | run cost.sh
  expect "<--project=-home-user-src-app> <--from=$STUB_D6> <--json>"
  expect "<--project=-home-user-src-app> <--from=$STUB_D29> <--json>"
  expect_out "Last 7 days      \$8.40"
  rm -f "$T/tools/date"
  ln -s "$(command -v date)" "$T/tools/date"

  new_case cost-top-sessions-local-days
  RUN_TZ=Pacific/Kiritimati STUB_SESSIONS=sessions-tz.json
  STUB_K7=$(export TZ=Pacific/Kiritimati; date_ago 7)
  printf 'q\n' | run cost.sh
  expect_out "TZ inside window"
  reject_out "TZ outside window"

  new_case cost-open
  printf 'x\no\n' | run cost.sh
  expect "claudescope <open>"
  reject "<open> <--session"
  expect "<--body> <Opened claudescope — http://127.0.0.1:4317>"

  new_case cost-no-project
  STUB_MATCH=none
  printf '\t\nq\n' | run cost.sh
  expect_out "claudescope · cost · all projects"
  expect_out "Today           \$99.50   150k tokens · 777 responses"
  expect "claudescope <analytics> <--group-by> <project> <--from=$STUB_D0> <--json>"
  reject "--project"
  # Tab has nothing to switch to, and the footer does not offer it
  reject_out "Tab project/all"
  expect_out "o open Claudescope · q close"
  if [ "$(count_log "<analytics>")" -eq 3 ]; then pass; else fail "no refetch on Tab without a project"; fi

  new_case cost-tab-scope
  printf '\t\nq\n' | run cost.sh
  expect_out "claudescope · cost · this project · app   /home/user/src/app"
  expect_out "Tab project/all · o open Claudescope · q close"
  expect_out "claudescope · cost · all projects"
  expect "claudescope <analytics> <--group-by> <project> <--from=$STUB_D0> <--json>"
  expect "claudescope <analytics> <--group-by> <project> <--from=$STUB_D6> <--json>"
  expect "claudescope <analytics> <--group-by> <project> <--from=$STUB_D29> <--json>"
  expect "claudescope <sessions> <--sort> <recent> <--limit> <200> <--json>"
  expect_out "Last 7 days     \$99.50   2.1M tokens · 777 responses"
  # all-projects top sessions: the same 7-day window, the project's name shown
  expect_out "other-proj     Other project migration"
  reject_out "Other project last month"
  # the pane's own session section stays in both scopes
  if [ "$(grep -c 'This pane    Fix login redirect' "$T/out")" -eq 2 ]; then pass; else fail "this pane section in both scopes"; fi

  new_case cost-tab-cached
  printf '\t\n\t\n\t\nq\n' | run cost.sh
  if [ "$(count_log "<--project=-home-user-src-app> <--from=$STUB_D0>")" -eq 1 ] &&
    [ "$(count_log "<analytics> <--group-by> <project> <--from=$STUB_D0>")" -eq 1 ]; then pass; else fail "each scope fetched once"; fi
  if [ "$(grep -c 'claudescope · cost · this project' "$T/out")" -eq 2 ] &&
    [ "$(grep -c 'claudescope · cost · all projects' "$T/out")" -eq 2 ]; then pass; else fail "three toggles drew four screens"; fi
  if [ "$(grep -c 'loading…' "$T/out")" -eq 2 ]; then pass; else fail "loading shown for the first fetch of each scope only"; fi

  new_case cost-loading-line
  printf 'q\n' | run cost.sh
  expect_out "loading…"
  loading=$(grep -n 'loading…' "$T/out" | head -n 1 | cut -d: -f1)
  today=$(grep -n 'Today' "$T/out" | head -n 1 | cut -d: -f1)
  if [ -n "$loading" ] && [ -n "$today" ] && [ "$loading" -lt "$today" ]; then pass; else fail "loading line before the cost screen"; fi

  new_case cost-concurrent-calls
  mkdir "$T/bar1"
  STUB_BARRIER="$T/bar1:2:live resolve"
  printf 'q\n' | run cost.sh
  expect_out "Today            \$1.25"
  barrier_met "$T/bar1"
  new_case cost-concurrent-ranges
  mkdir "$T/bar1"
  STUB_BARRIER="$T/bar1:4:analytics sessions"
  printf 'q\n' | run cost.sh
  expect_out "Last 7 days      \$8.40"
  expect_out "Fix login redirect"
  barrier_met "$T/bar1"
  new_case cost-concurrent-ranges-all-projects
  mkdir "$T/bar1"
  STUB_MATCH=none STUB_BARRIER="$T/bar1:4:analytics sessions"
  printf 'q\n' | run cost.sh
  expect_out "Last 7 days     \$99.50"
  expect_out "Other project migration"
  barrier_met "$T/bar1"

  new_case search-concurrent-and-loading
  mkdir "$T/bar1"
  STUB_BARRIER="$T/bar1:2:live resolve"
  CSH_SRC_PANE=w1:p1
  answers "ctrl-o|$C"
  run search.sh </dev/null
  expect "claudescope <open> <--session=$C>"
  expect_out "loading…"
  barrier_met "$T/bar1"

  new_case search-concurrent-keeps-live-toast
  STUB_LIVE_EXIT=3 CSH_SRC_PANE=w1:p1
  answers "ctrl-o|$C"
  run search.sh </dev/null
  expect "<--body> <starting claudescope…>"
  expect "claudescope <open> <--session=$C>"

  new_case search-concurrent-wedged-and-old-cli
  STUB_LIVE_EXIT=4
  run search.sh </dev/null
  expect "<--body> <claudescope is not responding"
  reject "<sessions>"
  new_case search-old-cli
  STUB_UNKNOWN=1
  run search.sh </dev/null
  expect "<--body> <This claudescope is too old for the herdr plugin. Upgrade it: claudescope update>"
  reject "<sessions>"

  # --- install-keys -------------------------------------------------------------
  BEGIN='# >>> claudescope herdr plugin keys >>>'
  BSTATE=$T/home/.local/state/herdr/plugins/claudescope
  new_case keys-fresh
  run install-keys.sh </dev/null
  cfg_has "$BEGIN"
  cfg_has '# <<< claudescope herdr plugin keys <<<'
  cfg_has 'key = "prefix+i"'
  cfg_has 'command = "claudescope.open-session"'
  cfg_has 'key = "prefix+f"'
  cfg_has 'command = "claudescope.search"'
  cfg_has 'key = "prefix+m"'
  cfg_has 'command = "claudescope.cost"'
  cfg_has 'type = "plugin_action"'
  expect "herdr <server> <reload-config>"
  expect "<--body> <claudescope key bindings: bound prefix+i, prefix+f, prefix+m>"
  if [ -e "$T/state/config.toml.bak" ]; then fail "no backup of a file that did not exist"; else pass; fi

  new_case keys-keeps-unrelated-content
  mkdir "$T/hconf"
  printf '# mine\n[ui]\ntheme = "dark"\n\n[[keys.command]]\nkey = "prefix+u"\ntype = "pane"' >"$T/orig"
  cp "$T/orig" "$CFG"
  run install-keys.sh </dev/null
  size=$(wc -c <"$T/orig")
  if [ "$(head -c "$size" "$CFG")" = "$(cat "$T/orig")" ]; then pass; else fail "bytes before the block preserved"; fi
  cfg_has "$BEGIN"
  if cmp -s "$T/state/config.toml.bak" "$T/orig"; then pass; else fail "backup is the original, in the state dir"; fi
  if [ -n "$(find "$T/state/config.toml.bak" -perm 600)" ]; then pass; else fail "backup is owner-only"; fi
  if [ -e "$CFG.bak" ]; then fail "no backup next to the config"; else pass; fi

  new_case keys-rerun-replaces-block
  mkdir "$T/hconf"
  printf '[a]\nx = 1\n' >"$CFG"
  run install-keys.sh </dev/null
  printf '[b]\ny = 2\n' >>"$CFG"
  printf 'CLAUDESCOPE_KEY_SEARCH=prefix+y\nCLAUDESCOPE_KEY_COST=prefix+$\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  if [ "$(grep -cF "$BEGIN" "$CFG")" -eq 1 ] && [ "$(grep -c 'command = "claudescope.search"' "$CFG")" -eq 1 ]; then pass; else fail "one block, no duplicate"; fi
  cfg_has 'key = "prefix+y"'
  cfg_has 'key = "prefix+$"'
  cfg_lacks 'key = "prefix+f"'
  cfg_lacks 'key = "prefix+m"'
  if [ "$(sed -n 1,2p "$CFG")" = "$(printf '[a]\nx = 1')" ] && [ "$(tail -n 2 "$CFG")" = "$(printf '[b]\ny = 2')" ]; then pass; else fail "content before and after the block untouched, block in place"; fi

  new_case keys-symlinked-config
  mkdir "$T/hconf" "$T/dots"
  printf '[ui]\ntheme = "dark"\n' >"$T/dots/config.toml"
  ln -s "$T/dots/config.toml" "$CFG"
  run install-keys.sh </dev/null
  if [ -L "$CFG" ]; then pass; else fail "config is still a symlink"; fi
  if grep -qF "$BEGIN" "$T/dots/config.toml" && grep -qF 'theme = "dark"' "$T/dots/config.toml"; then pass; else fail "link target edited in place"; fi
  if cmp -s "$T/state/config.toml.bak" - <<'EOF2'
[ui]
theme = "dark"
EOF2
  then pass; else fail "backup read through the link"; fi

  new_case keys-conflict-outside-block
  mkdir "$T/hconf"
  printf '[[keys.command]]\nkey = "prefix+f"\ntype = "pane"\n' >"$CFG"
  run install-keys.sh </dev/null
  if [ "$(grep -cF 'key = "prefix+f"' "$CFG")" -eq 1 ]; then pass; else fail "conflicting key not bound again"; fi
  cfg_has 'key = "prefix+i"'
  cfg_has 'key = "prefix+m"'
  expect "<--body> <claudescope key bindings: bound prefix+i, prefix+m; skipped prefix+f (already bound)>"

  new_case keys-conflict-builtin-remap
  mkdir "$T/hconf"
  printf '[keys]\nnext_agent = "prefix+a"   # remap\nother = [ "ctrl+q",\n  "Prefix+Y" ]\n# old = "prefix+m"\n\n[ui]\nx = "prefix+m"\n' >"$CFG"
  printf 'CLAUDESCOPE_KEY_OPEN_SESSION=prefix+a\nCLAUDESCOPE_KEY_SEARCH=prefix+y\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  expect "<--body> <claudescope key bindings: bound prefix+m; skipped prefix+a (already bound), prefix+y (already bound)>"
  cfg_lacks 'key = "prefix+a"'
  cfg_lacks 'key = "prefix+y"'
  cfg_has 'key = "prefix+m"'

  new_case keys-refuse-inline-keys-command
  mkdir "$T/hconf"
  for body in '[keys]\ncommand = [{ key = "x" }]\n' 'keys.command = []\n[ui]\n' '[keys.command]\nkey = "x"\n' 'keys = { command = [] }\n'; do
    printf '%b' "$body" >"$CFG"
    cp "$CFG" "$T/inline"
    : >"$STUB_LOG"
    run_build
    rc=$?
    if [ "$rc" -eq 0 ] && cmp -s "$CFG" "$T/inline"; then pass; else fail "inline keys.command left alone, exit 0 (rc $rc): $body"; fi
    expect_out "defines keys.command inline"
    if [ -e "$BSTATE/keys-installed" ]; then fail "no marker for a refused config: $body"; else pass; fi
    reject "<reload-config>"
  done
  printf '[ui]\nkeys.command = 1\n[[keys.command]]\nkey = "prefix+u"\ntype = "pane"\n' >"$CFG"
  run_build
  cfg_has "$BEGIN"

  new_case keys-keeps-first-backup
  mkdir "$T/hconf"
  printf '[ui]\ntheme = "dark"\n' >"$CFG"
  cp "$CFG" "$T/orig"
  run install-keys.sh </dev/null
  printf 'CLAUDESCOPE_KEY_SEARCH=prefix+y\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  if cmp -s "$T/state/config.toml.bak" "$T/orig"; then pass; else fail "a re-run keeps the first backup"; fi

  new_case keys-write-failure-restores-original
  rm -f "$T/state/keys-installed"
  mkdir "$T/hconf"
  printf '[ui]\ntheme = "dark"\n' >"$CFG"
  cp "$CFG" "$T/orig"
  rm -f "$T/tools/cat"
  # shellcheck disable=SC2016 # script text, not expanded here
  printf '#!/bin/sh\ncase $1 in */new) printf PARTIAL; exit 1 ;; esac\nexec %s "$@"\n' "$(command -v cat)" >"$T/tools/cat"
  chmod +x "$T/tools/cat"
  run install-keys.sh </dev/null
  rm -f "$T/tools/cat"
  ln -s "$(command -v cat)" "$T/tools/cat"
  if cmp -s "$CFG" "$T/orig"; then pass; else fail "config restored after a failed write"; fi
  expect "could not write $CFG; the original is restored (backup: $T/state/config.toml.bak)"
  if [ -e "$T/state/keys-installed" ]; then fail "no marker after a failed write"; else pass; fi

  new_case keys-crlf-config
  mkdir "$T/hconf"
  printf '[keys]\r\nnext_agent = "prefix+a"\r\n' >"$CFG"
  printf 'CLAUDESCOPE_KEY_SEARCH=prefix+a\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  expect "skipped prefix+a (already bound)"
  printf '[ui]\nx = 1\n' >"$CFG"
  run install-keys.sh </dev/null
  sed "s/\$/$(printf '\r')/" "$CFG" >"$T/crlf" && cat "$T/crlf" >"$CFG"
  cp "$CFG" "$T/before-rerun"
  printf 'CLAUDESCOPE_KEY_SEARCH=prefix+y\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  if [ "$(grep -cF '# >>> claudescope herdr plugin keys >>>' "$CFG")" -eq 1 ]; then pass; else fail "a CRLF file gets one block"; fi
  if [ "$(head -n 2 "$CFG")" = "$(head -n 2 "$T/before-rerun")" ]; then pass; else fail "CRLF bytes before the block preserved"; fi
  cfg_has 'key = "prefix+y"' 

  new_case keys-default-key-skipped
  printf 'CLAUDESCOPE_KEY_SEARCH=prefix+o\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  cfg_lacks 'prefix+o'
  cfg_has 'key = "prefix+i"'
  expect "skipped prefix+o (herdr default)"
  expect "herdr <server> <reload-config>"

  new_case keys-all-skipped
  printf 'CLAUDESCOPE_KEY_OPEN_SESSION=prefix+o\nCLAUDESCOPE_KEY_SEARCH=prefix+s\nCLAUDESCOPE_KEY_COST=shift+tab\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  if [ -e "$CFG" ]; then fail "nothing written when every key is skipped"; else pass; fi
  expect "<--body> <claudescope key bindings: nothing bound, skipped prefix+o (herdr default), prefix+s (herdr default), shift+tab (herdr default)>"
  reject "<reload-config>"

  new_case keys-invalid-value-aborts
  printf 'CLAUDESCOPE_KEY_COST=prefix+m"; evil\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  if [ -e "$CFG" ]; then fail "nothing written for an invalid key"; else pass; fi
  expect "<--body> <claudescope key bindings: CLAUDESCOPE_KEY_COST is not a valid key; nothing written>"
  reject "<reload-config>"

  # --- install-keys --build (the [[build]] hook: no herdr env at all) -----------
  new_case build-fresh
  run_build
  rc=$?
  if [ "$rc" -eq 0 ]; then pass; else fail "build exits 0 (got $rc)"; fi
  cfg_has "$BEGIN"
  cfg_has 'command = "claudescope.search"'
  if [ -e "$BSTATE/keys-installed" ]; then pass; else fail "marker written in the derived state dir"; fi
  expect "herdr <server> <reload-config>"
  expect_out "claudescope key bindings: bound prefix+i, prefix+f, prefix+m"

  cp "$CFG" "$T/after-first"
  : >"$STUB_LOG"
  run_build
  rc=$?
  if [ "$rc" -eq 0 ]; then pass; else fail "second build exits 0 (got $rc)"; fi
  if cmp -s "$CFG" "$T/after-first"; then pass; else fail "second build leaves the config byte-identical"; fi
  expect_out "key bindings were set up before; run \`herdr plugin action invoke claudescope.install-keys\` to change them"
  reject "<reload-config>"

  new_case build-user-deleted-block
  run_build
  printf '[ui]\ntheme = "dark"\n' >"$CFG"
  cp "$CFG" "$T/after-delete"
  run_build
  rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$CFG" "$T/after-delete"; then pass; else fail "a deleted block is not restored on update (rc $rc)"; fi

  new_case build-existing-block-no-marker
  mkdir "$T/hconf"
  run install-keys.sh </dev/null
  cp "$CFG" "$T/before-build"
  rm -f "$T/state/keys-installed" "$T/home/.local/state/herdr/plugins/claudescope/keys-installed"
  : >"$STUB_LOG"
  run_build
  rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$CFG" "$T/before-build"; then pass; else fail "existing block left alone (rc $rc)"; fi
  if [ -e "$BSTATE/keys-installed" ]; then pass; else fail "marker written next to an existing block"; fi
  reject "<reload-config>"

  new_case build-reload-fails
  STUB_RELOAD_FAIL=1
  run_build
  rc=$?
  if [ "$rc" -eq 0 ]; then pass; else fail "failed reload still exits 0 (got $rc)"; fi
  cfg_has "$BEGIN"
  expect_out "restart herdr or run \`herdr server reload-config\` to activate them"

  new_case build-unwritable-config
  mkdir "$T/hconf"
  chmod 555 "$T/hconf"
  if (: >"$CFG") 2>/dev/null; then
    rm -f "$CFG"
  else
    run_build
    rc=$?
    if [ "$rc" -eq 0 ]; then pass; else fail "unwritable config exits 0 (got $rc)"; fi
    expect_out "could not write $CFG"
    if [ -e "$BSTATE/keys-installed" ]; then fail "no marker when nothing was written"; else pass; fi
  fi

  new_case build-all-skipped-sets-marker
  mkdir -p "$T/home/.config/herdr/plugins/config/claudescope"
  printf 'CLAUDESCOPE_KEY_OPEN_SESSION=prefix+o\nCLAUDESCOPE_KEY_SEARCH=prefix+s\nCLAUDESCOPE_KEY_COST=shift+tab\n' \
    >"$T/home/.config/herdr/plugins/config/claudescope/.env"
  run_build
  if [ -e "$BSTATE/keys-installed" ] && [ ! -e "$CFG" ]; then pass; else fail "marker set, config untouched, when every key is skipped"; fi

  new_case build-then-action
  run_build
  run install-keys.sh </dev/null
  if [ "$(grep -cF "$BEGIN" "$CFG")" -eq 1 ]; then pass; else fail "action after build replaces the block, no duplicate"; fi
  expect "<--body> <claudescope key bindings: bound prefix+i, prefix+f, prefix+m>"
  if [ -e "$T/state/keys-installed" ]; then pass; else fail "action writes the marker"; fi
  printf 'CLAUDESCOPE_KEY_SEARCH=prefix+y\n' >>"$T/config/.env"
  run install-keys.sh </dev/null
  cfg_has 'key = "prefix+y"'

  rm -rf "$T"
}

for shell in ${TEST_SHELLS:-sh dash}; do
  command -v "$shell" >/dev/null 2>&1 || continue
  suite "$shell"
done

printf '%s passed, %s failed\n' "$passes" "$fails"
[ "$fails" -eq 0 ]
