# Install and run

Install from any one of three channels — all wrap the same package. However you
install it, `claudescope` serves the whole app (UI + API) from a single port
(**http://localhost:4317** by default), runs in the **background**, and opens
your browser. Run it once and forget it; new sessions appear automatically.

## npm (recommended)

**Prerequisite:** [Node.js](https://nodejs.org) **22.13 or newer** (`node -v`).

```bash
npm install -g @vladar107/claudescope
claudescope            # starts the app in the background and opens your browser
```

No global install? `npx @vladar107/claudescope` runs the published CLI once
without installing it.

## Homebrew (macOS / Linux)

```bash
brew tap vladar107/tap
brew install claudescope
claudescope
```

## Nix (any platform)

```bash
nix run github:vladar107/claudescope               # run without installing
nix profile install github:vladar107/claudescope   # or add it to your profile
```

## Run from source

```bash
git clone https://github.com/vladar107/claudescope && cd claudescope
npm install      # installs all workspace dependencies
npm start        # builds on first run, then serves the app in the foreground
```

`npm start` runs in the foreground (`Ctrl-C` to stop). For the watch-mode dev
loop and how to contribute, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
