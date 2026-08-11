# TidaLuna Plugins

A collection of [TidaLuna](https://github.com/Inrixia/TidaLuna) plugins that extend the TIDAL
Desktop client — Windows media controls, a local HTTP/WebSocket API, and lyrics translation.
Install them from the Plugin Store, or build them yourself.

## Plugins

### TidalMediaControls

**Location:** `plugins/tidal-shuffle-repeat/`

Gives TIDAL full Windows media controls through the System Media Transport Controls (SMTC),
so media flyouts and other SMTC consumers work properly instead of half-working.

**Features:**

- Transport, shuffle, repeat and seek — synced both ways
- Rich metadata: title, artists, album, album artist, track number, genre, cover art
- Smooth seekbar (event-driven timeline with OS extrapolation)
- Works with [FluentFlyout](https://github.com/unchihugo/FluentFlyout), ModernFlyout, the
  native flyout and the lock screen
- Optional startup optimization so it works with no relaunch

### TidalAPI

**Location:** `plugins/api/`

A local HTTP + WebSocket API for TIDAL on port `24123` — a Spotify-Web-API-shaped surface for
controlling and monitoring the client from outside.

**Features:**

- Playback state, queue, search, track/album/artist/playlist lookups, lyrics, favourites
- Transport controls, volume, shuffle, repeat, play/queue manipulation
- WebSocket subscriptions for real-time state updates
- Optional bearer token, loopback-only by default
- Extendable: other plugins can register their own actions

Originally by [vMohammad](https://vmohammad.dev), whose repo is deprecated — ported, modernized
and extended here.

### TidalLyricsTranslate

**Location:** `plugins/lyrics-translate/`

Translates and romanizes lyrics in place, in both the synced and unsynced view.

**Features:**

- Bilingual lyrics — original and translation together, not one replacing the other
- Romanization of non-latin lyrics (Japanese, Korean, Russian, Arabic…)
- Stays in sync: translations are written back into the LRC timeline
- One-click toggle back to the original, with per-track caching
- Auto-translate on track change, and skips lyrics already in your language

Built on [vMohammad](https://vmohammad.dev)'s `translate` plugin, rewritten here.

## Installation

### Batteries required

1. [TidaLuna](https://github.com/Inrixia/TidaLuna) — the plugin framework these are built for
2. TIDAL Desktop — the thing being modded

### Installing from the Plugin Store

1. Open TIDAL (with Luna installed)
2. Open **Luna Settings** (top right of TIDAL)
3. Click the **Plugin Store** tab
4. Paste this into **Install from URL**:
   `https://github.com/FireWall-code/TidaLuna-Plugins/releases/download/latest/store.json`
5. Install the plugins you want, then tune them in the **Plugins** tab

Pushes to `master` auto-publish a fresh build to the `latest` GitHub release, so the store URL
always serves the current code.

## Installation from source

```bash
# Clone the repo
git clone https://github.com/FireWall-code/TidaLuna-Plugins

# Change folder to the repo
cd TidaLuna-Plugins

# Install dependencies
pnpm install

# Build & serve all plugins
pnpm run watch
```

Then in TIDAL: **Luna Settings → Plugin Store → Install from URL** →
`http://localhost:3000/store.json`, and install the plugins marked `[Dev]`. Reload a plugin
after each rebuild.

## Repo layout

- `plugins/*` — one folder per plugin (renderer code, plus `.native.ts` bridges where a plugin
  needs the main process)
- `smtc-bridge/` — Rust + [napi-rs](https://napi.rs/) source for TidalMediaControls' native SMTC
  addon. The compiled addon is embedded as base64 in `plugins/tidal-shuffle-repeat/src/native-bin.ts`,
  so the published `.mjs` is self-contained and CI needs no Rust toolchain.

### Rebuilding the native addon

TIDAL Desktop is 32-bit Electron, so the addon targets `i686-pc-windows-msvc`.

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

## GitHub Actions

- **Automated builds** on every push
- **Release automation** — every push to `master` republishes the `latest` release
- **Artifact uploads** so the store URL always points at the current build

## Credits

- [Inrixia](https://github.com/Inrixia) — [TidaLuna](https://github.com/Inrixia/TidaLuna), the
  plugin framework (successor to Neptune)
- [vMohammad](https://github.com/vMohammad24) — original `api` and `translate` plugins
- [meowarex](https://github.com/meowarex) — lyrics-view button placement
