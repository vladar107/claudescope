#!/bin/sh
# Action `install-keys`: bind the plugin's actions in herdr's config.toml. herdr
# 0.9.5 lets a plugin declare no keys, so this writes them on the user's
# request, inside a marked block that a re-run replaces in place. Nothing
# outside the block is touched. The config is often a symlink into a dotfiles
# repo, so it is edited through the link, never replaced.
#
# `--build` is the manifest's [[build]] hook: it runs once at `herdr plugin
# install` (and again on every update, which reinstalls) with no herdr runtime
# env, so the state and config dirs are derived, the outcome is printed (a
# notification may not be deliverable yet), it always exits 0 so it can never
# fail an install, and a marker in the state dir keeps updates from rebinding.
CSH_BIN=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$CSH_BIN/lib.sh"

BEGIN='# >>> claudescope herdr plugin keys >>>'
END='# <<< claudescope herdr plugin keys <<<'

BUILD=0
[ "${1:-}" = --build ] && BUILD=1

# say <message>: a notification; at build time also stdout, which is what the
# install shows.
say() {
  [ "$BUILD" = 1 ] && printf '%s\n' "$1"
  csh_toast "$1"
}

cfg=${HERDR_CONFIG_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml}

state=${HERDR_PLUGIN_STATE_DIR:-}
if [ "$BUILD" = 1 ]; then
  [ -n "$state" ] || state=${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/$CSH_PLUGIN_ID
  [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] ||
    HERDR_PLUGIN_CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/$CSH_PLUGIN_ID
  marker=$state/keys-installed
  mkdir -p "$state" || {
    say "claudescope key bindings: could not create $state; nothing written"
    exit 0
  }
  if [ -e "$marker" ]; then
    say "claudescope: key bindings were set up before; run \`herdr plugin action invoke claudescope.install-keys\` to change them"
    exit 0
  fi
elif [ -z "$state" ]; then
  say "claudescope key bindings: HERDR_PLUGIN_STATE_DIR is not set; nothing written"
  exit 0
fi
marker=$state/keys-installed
env_file=$(csh_env_file)

# valid_key <key>: only characters a herdr key name uses; the value ends up
# inside a TOML string.
valid_key() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9+_$/?-]+$'
}

# is_default <key>: herdr's own default bindings.
is_default() {
  id_k=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case $id_k in
    'prefix+?' | prefix+[swgqocpnehjklvxzrb] | prefix+minus | prefix+- | prefix+tab | prefix+[1-9]) return 0 ;;
    shift+[ngwdrtxphjkl] | shift+tab) return 0 ;;
  esac
  return 1
}

# bound_outside <key> <file>: is the key bound by a `key = "…"` line in the file,
# or listed in <file>.keys (the values of the `[keys]` table: builtin remaps)?
bound_outside() {
  bo_k=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  {
    sed -n -e 's/^[[:space:]]*key[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
      -e "s/^[[:space:]]*key[[:space:]]*=[[:space:]]*'\\([^']*\\)'.*/\\1/p" "$2"
    [ -r "$2.keys" ] && cat "$2.keys"
  } | tr '[:upper:]' '[:lower:]' | grep -Fxq -- "$bo_k"
}

# keys_table <file>: the lines of the `[keys]` table, header excluded.
keys_table() {
  sed -n -e '/^[[:space:]]*\[[[:space:]]*keys[[:space:]]*\][[:space:]]*\(#.*\)\{0,1\}$/,/^[[:space:]]*\[/p' "$1" |
    sed -e '1d' -e '/^[[:space:]]*\[/d'
}

# keys_table_values <file>: every quoted string value assigned in the `[keys]`
# table (`action = "key"` or `action = ["k1", "k2"]`), one per line.
keys_table_values() {
  keys_table "$1" | sed -e '/^[[:space:]]*#/d' -e 's/[[:space:]]#.*$//' -e 's/^[^=]*=//' |
    {
      grep -o -e '"[^"]*"' -e "'[^']*'" || :
    } | sed -e 's/^.//' -e 's/.$//'
}

# defines_keys_command_inline <file>: does the config define keys.command in a
# way that makes an appended `[[keys.command]]` invalid TOML?
defines_keys_command_inline() {
  keys_table "$1" | grep -Eq '^[[:space:]]*"?command"?[[:space:]]*=' && return 0
  sed -n -e '/^[[:space:]]*\[/q' -e p "$1" |
    grep -Eq '^[[:space:]]*("?keys"?[[:space:]]*=|"?keys"?[[:space:]]*\.[[:space:]]*"?command"?[[:space:]]*=)' && return 0
  grep -Eq '^[[:space:]]*\[[[:space:]]*"?keys"?[[:space:]]*\.[[:space:]]*"?command"?[[:space:]]*\][[:space:]]*(#.*)?$' "$1"
}

# env_key <ENV_NAME> <default>: the key from the plugin's .env, else the default.
env_key() {
  ek_v=$(csh_env_value "$1" "$env_file") || ek_v=$2
  if ! valid_key "$ek_v"; then
    say "claudescope key bindings: $1 is not a valid key; nothing written"
    return 1
  fi
  printf '%s\n' "$ek_v"
}
key_open=$(env_key CLAUDESCOPE_KEY_OPEN_SESSION prefix+i) || exit 0
key_search=$(env_key CLAUDESCOPE_KEY_SEARCH prefix+f) || exit 0
key_cost=$(env_key CLAUDESCOPE_KEY_COST prefix+m) || exit 0

tmp=$(mktemp -d "${TMPDIR:-/tmp}/claudescope-herdr.XXXXXX") || {
  say "claudescope key bindings: could not create a temp dir"
  exit 0
}
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM HUP

[ -e "$cfg" ] && [ ! -r "$cfg" ] && {
  say "claudescope key bindings: cannot read $cfg"
  exit 0
}
existed=0
if [ -e "$cfg" ]; then
  existed=1
  cat "$cfg" >"$tmp/orig"
else
  : >"$tmp/orig"
fi
# A CRLF file: every scan reads a copy without the CRs; the bytes written back
# come from the original.
tr -d '\r' <"$tmp/orig" >"$tmp/scan"

# Split the config around an existing block.
begin_n=$(grep -nFx -- "$BEGIN" "$tmp/scan" | head -n 1 | cut -d: -f1)
end_n=$(grep -nFx -- "$END" "$tmp/scan" | head -n 1 | cut -d: -f1)
if [ -n "$begin_n" ] && [ -n "$end_n" ] && [ "$begin_n" -lt "$end_n" ]; then
  if [ "$BUILD" = 1 ]; then
    : >"$marker"
    say "claudescope key bindings: already present in $cfg; left as is"
    exit 0
  fi
  head -n "$((begin_n - 1))" "$tmp/orig" >"$tmp/before"
  tail -n "+$((end_n + 1))" "$tmp/orig" >"$tmp/after"
elif [ -z "$begin_n" ] && [ -z "$end_n" ]; then
  cp "$tmp/orig" "$tmp/before"
  : >"$tmp/after"
else
  say "claudescope key bindings: the marker lines in $cfg are incomplete; fix or remove them first"
  exit 0
fi
cat "$tmp/before" "$tmp/after" | tr -d '\r' >"$tmp/outside"
if defines_keys_command_inline "$tmp/outside"; then
  say "claudescope key bindings: $cfg defines keys.command inline, so a [[keys.command]] block cannot be added; convert it to [[keys.command]] entries first. Nothing written"
  exit 0
fi
keys_table_values "$tmp/outside" >"$tmp/outside.keys"

# Pick the keys that are free; name the others.
bound='' skipped=''
: >"$tmp/block"
# add_key <key> <action> <description>
add_key() {
  if is_default "$1"; then
    skipped="$skipped${skipped:+, }$1 (herdr default)"
  elif bound_outside "$1" "$tmp/outside"; then
    skipped="$skipped${skipped:+, }$1 (already bound)"
  elif bound_outside "$1" "$tmp/block"; then
    skipped="$skipped${skipped:+, }$1 (used twice)"
  else
    bound="$bound${bound:+, }$1"
    {
      printf '[[keys.command]]\nkey = "%s"\ntype = "plugin_action"\n' "$1"
      printf 'command = "%s.%s"\ndescription = "%s"\n\n' "$CSH_PLUGIN_ID" "$2" "$3"
    } >>"$tmp/block"
  fi
}
add_key "$key_open" open-session "Claudescope: open this pane's session"
add_key "$key_search" search "Claudescope: search and resume"
add_key "$key_cost" cost "Claudescope: project cost"

if [ -z "$bound" ]; then
  [ "$BUILD" = 1 ] && : >"$marker"
  say "claudescope key bindings: nothing bound, skipped $skipped"
  exit 0
fi

{
  cat "$tmp/before"
  if [ -z "$begin_n" ]; then
    if [ -s "$tmp/before" ]; then
      [ -n "$(tail -c 1 "$tmp/before")" ] && printf '\n'
      printf '\n'
    fi
  fi
  printf '%s\n' "$BEGIN"
  printf '# Written by the claudescope.install-keys action; a re-run replaces this block.\n'
  cat "$tmp/block"
  printf '%s\n' "$END"
  cat "$tmp/after"
} >"$tmp/new"

mkdir -p "$state" "$(dirname -- "$cfg")" || exit 0
bak=$state/config.toml.bak
# The first backup is the user's own file: a retry must never replace it.
if [ "$existed" = 1 ] && [ ! -e "$bak" ]; then
  if ! cat "$tmp/orig" >"$bak"; then
    rm -f "$bak"
    say "claudescope key bindings: could not save a backup to $bak; nothing written"
    exit 0
  fi
fi
if ! cat "$tmp/new" >"$cfg"; then
  if [ "$existed" = 1 ]; then
    if cat "$tmp/orig" >"$cfg"; then
      say "claudescope key bindings: could not write $cfg; the original is restored (backup: $bak)"
    else
      say "claudescope key bindings: could not write $cfg and could not restore it; the original is at $bak"
    fi
  else
    rm -f "$cfg"
    say "claudescope key bindings: could not write $cfg"
  fi
  exit 0
fi
: >"$marker"

msg="bound $bound"
[ -n "$skipped" ] && msg="$msg; skipped $skipped"
if "$CSH_HERDR" server reload-config >/dev/null 2>&1; then
  say "claudescope key bindings: $msg"
elif [ "$BUILD" = 1 ]; then
  say "claudescope key bindings: $msg; restart herdr or run \`herdr server reload-config\` to activate them"
else
  say "claudescope key bindings: $msg; run: herdr server reload-config"
fi
if [ "$BUILD" = 1 ] && [ -e "$state/config.toml.bak" ]; then
  printf 'claudescope key bindings: original config saved to %s\n' "$state/config.toml.bak"
fi
exit 0
