{
  description = "Local, read-only viewer for AI coding-agent transcripts (Claude Code, Codex, Junie)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        inherit (pkgs) lib;
        node = pkgs.nodejs_22;

        claudescope = pkgs.buildNpmPackage {
          pname = "claudescope";
          # Single source of truth: the version comes from the root package.json,
          # the same value esbuild bakes into the bundle at build time.
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

          # Build from the monorepo itself — this is why the flake must live at the
          # repo root (a subdir flake's `self` can't reach the parent sources).
          src = self;

          # Fixed-output hash of the npm dependency closure (from package-lock.json).
          # Refresh after any dependency change with:
          #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          # A version-only bump does NOT change this. Placeholder = lib.fakeHash:
          # the first real `nix build` prints the correct value to paste in here.
          npmDepsHash = lib.fakeHash;

          nodejs = node;

          # `npm run bundle` assembles dist/ (server + CLI + web + pricing default).
          npmBuildScript = "bundle";

          # We install dist/ ourselves rather than the default `npm install` layout.
          dontNpmInstall = true;

          nativeBuildInputs =
            [ pkgs.makeWrapper ]
            # The prebuilt DuckDB .node is a downloaded ELF on Linux; patch its
            # interpreter/rpath against nixpkgs. macOS dylib needs no patching.
            ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
          buildInputs = lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/claudescope
            cp -R dist/. $out/lib/claudescope/

            # The bundle keeps @duckdb/node-api external, so its package (and the
            # host-platform @duckdb/node-bindings-* binary) must sit beside cli.js
            # at runtime. autoPatchelfHook then fixes the .node on Linux.
            mkdir -p $out/lib/claudescope/node_modules/@duckdb
            cp -R node_modules/@duckdb/. $out/lib/claudescope/node_modules/@duckdb/

            # Wrap the CLI with the pinned Node and put coreutils on PATH (the
            # `logs -f` command shells out to `tail`).
            makeWrapper ${node}/bin/node $out/bin/claudescope \
              --add-flags $out/lib/claudescope/cli.js \
              --prefix PATH : ${lib.makeBinPath [ pkgs.coreutils ]}

            runHook postInstall
          '';

          meta = {
            description = "Local, read-only viewer for AI coding-agent transcripts";
            homepage = "https://github.com/vladar107/claudescope";
            license = lib.licenses.mit;
            mainProgram = "claudescope";
            platforms = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
          };
        };
      in
      {
        packages.default = claudescope;
        packages.claudescope = claudescope;

        apps.default = {
          type = "app";
          program = "${claudescope}/bin/claudescope";
        };

        # `nix flake check` smoke test: the CLI starts and reports its version.
        checks.default = pkgs.runCommand "claudescope-version" { } ''
          ${claudescope}/bin/claudescope version > "$out"
        '';
      }
    );
}
