# Claudescope plugin for herdr

Jump from a [herdr](https://herdr.dev) pane to its agent session in
Claudescope, search past sessions from every agent and resume one in a new
split, and see what the project has cost.

| Action | What it does |
| --- | --- |
| `claudescope.open-session` | Opens the focused pane's session in the browser. Uses the session id herdr's agent integration reports; without one, matches by folder, shows a picker when several sessions there are live, and says so in a notification. |
| `claudescope.search` | Popup listing this project's sessions; typing searches transcripts. Tab switches to all projects, Enter resumes in a split to the right, Ctrl-F forks, Ctrl-O opens in the browser. |
| `claudescope.cost` | Popup with the project's cost for today, 7 and 30 days, this pane's session, and the top sessions of the week. Tab switches between this project and all projects; `o` opens Claudescope in the browser. |
| `claudescope.install-keys` | Binds the three actions above to keys in herdr's `config.toml` (see below). |

## Requirements

- herdr 0.9.5 or newer, on macOS or Linux.
- The `claudescope` CLI with the `resolve` command (see the
  [install guide](https://claudescope.ramazaev.dev/#install)).
- `jq`. `fzf` is optional; without it the popups use a numbered list.

## Install

```bash
herdr plugin install vladar107/claudescope/plugins/herdr
```

## Key bindings

Installing from GitHub binds `prefix+i`, `prefix+f` and `prefix+m` once,
automatically (the install preview lists this build step). An update never
rebinds: a `keys-installed` marker in the plugin's state directory records that
it ran. `herdr plugin link` (local development) skips the step.

herdr 0.9.5 has no way for a plugin to declare keys, so to bind them yourself,
or to change or redo them, run:

```bash
herdr plugin action invoke claudescope.install-keys
```

This binds `prefix+i` (open this pane's session), `prefix+f` (search) and
`prefix+m` (cost), then reloads herdr's config. It edits `config.toml` in place
(a symlinked config stays a symlink), writes only a block between
`# >>> claudescope herdr plugin keys >>>` and `# <<< claudescope herdr plugin keys <<<`
(a re-run replaces that block), and the first time it runs saves the
original file to `config.toml.bak` in the plugin's state directory (a later
run keeps that backup). A key that is already
bound elsewhere in the config, or is one of herdr's defaults, is skipped and
named in the notification. To remove the bindings, delete that block from
`config.toml` (the marker keeps updates from adding it back).

To pick other keys, set any of these in the plugin's `.env` file
(`$(herdr plugin config-dir claudescope)/.env`) and run the action again:

```bash
CLAUDESCOPE_KEY_OPEN_SESSION=prefix+i
CLAUDESCOPE_KEY_SEARCH=prefix+f
CLAUDESCOPE_KEY_COST=prefix+m
```

Or bind them by hand in `~/.config/herdr/config.toml` (any free keys work; note
that `prefix+o` is herdr's default `open_notification_target`), then run
`herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "claudescope.open-session"
description = "Claudescope: open this pane's session"

[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "claudescope.search"
description = "Claudescope: search and resume"

[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "claudescope.cost"
description = "Claudescope: project cost"
```

## Finding the CLI

herdr runs plugin commands with its server's environment, which often lacks
the directories fnm, nvm, or a global npm install add to `PATH`. The plugin
looks for `claudescope` in this order:

1. `CLAUDESCOPE_BIN` in the plugin's `.env` file
   (`$(herdr plugin config-dir claudescope)/.env`). The file is read, never
   executed.
2. `PATH`.
3. The fnm default alias, the npm global prefix, and Homebrew.

If none works, a notification names the `.env` file to set, for example:

```bash
CLAUDESCOPE_BIN=~/.local/share/fnm/aliases/default/bin/claudescope
```

## Notes

- The first action after a reboot may take a few seconds while Claudescope
  starts its daemon; a notification says so.
- Exact matching needs the agent's herdr integration
  (`herdr integration install <agent>`). It is verified for Claude Code; other
  agents fall back to matching by folder.
- Resuming a session that is still live in another pane asks first, since two
  agents would then write to the same session.

## Tests

```bash
sh plugins/herdr/test/run.sh
```

Runs every script against stub `claudescope`, `herdr`, and `fzf` binaries,
under `sh` and `dash`; it never touches a real herdr or Claudescope.
