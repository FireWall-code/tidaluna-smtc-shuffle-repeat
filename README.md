# tidaluna-smtc-shuffle-repeat

A [TidaLuna](https://github.com/Inrixia/TidaLuna) plugin store containing
**TidalMediaControls** — it gives TIDAL full Windows media controls (transport,
shuffle, repeat, seek, rich metadata and cover art) through the System Media
Transport Controls (SMTC), so media/volume flyouts like
[FluentFlyout](https://github.com/unchihugo/FluentFlyout) and other SMTC consumers
work fully. Bidirectional sync.

See [`plugins/tidal-shuffle-repeat/README.md`](plugins/tidal-shuffle-repeat/README.md)
for what it does and how it works.

## Install (in TidaLuna)

Add this repo's plugin store in TidaLuna, then install **TidalMediaControls**
from the Plugin Store. (Pushes to `master` auto-publish the build to the `latest`
GitHub release via the included workflow.)

## Repo layout

- `plugins/tidal-shuffle-repeat/` — the plugin (renderer + `.native.ts` bridge).
  The compiled native addon is embedded as base64 in `src/native-bin.ts`, so the
  published `.mjs` is fully self-contained (CI does not need a Rust toolchain).
- `smtc-bridge/` — Rust + [napi-rs](https://napi.rs/) source for the native SMTC
  addon (uses the Windows `windows` crate).

## Rebuilding the native addon

TIDAL desktop is 32-bit Electron, so the addon targets `i686-pc-windows-msvc`.

```powershell
# Requirements: Rust (rustup), VS Build Tools (C++ x86), Node, pnpm
rustup target add i686-pc-windows-msvc
cd smtc-bridge
pnpm install
# build inside a VS x86 dev env (build32.bat does: vcvarsall x86 + napi build --target i686)
.\build32.bat
# re-embed the freshly built .node as base64 into the plugin:
.\embed.ps1
```
