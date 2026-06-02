# TidalMediaControls

A [TidaLuna](https://github.com/Inrixia/TidaLuna) plugin that gives TIDAL **full
Windows media controls** through the System Media Transport Controls (SMTC).

By default TIDAL (an Electron/Chromium app) only exposes play/pause/next/previous
to Windows, with greyed-out shuffle/repeat and a non-interactive progress bar.
This plugin replaces that with a complete, rich SMTC session.

## Features

- **Transport**: play · pause · next · previous
- **Shuffle & repeat** — exposed and fully bidirectional
- **Seek** — the progress bar in the flyout becomes interactive (drag to seek)
- **Rich metadata**: title · artist · album · album artist · track number ·
  track count · genre · **cover art** · live timeline / playback status
- **Bidirectional sync** — changes in TIDAL update the controls, and the controls
  drive TIDAL

Everything is delivered through the standard Windows SMTC, so it works with the
native Windows media flyout, the lock screen,
[FluentFlyout](https://github.com/unchihugo/FluentFlyout), ModernFlyout, media-key
hardware, widgets, scrobblers, and any other SMTC consumer.

## How it works

- A native addon (Rust + [napi-rs](https://napi.rs/), Windows `windows` crate)
  publishes the SMTC session and handles shuffle/repeat/seek/button requests. The
  compiled `.node` is embedded (base64) so the plugin is self-contained.
- The renderer drives TIDAL via `@luna/lib`'s `PlayState` and mirrors TIDAL's
  state + metadata back onto the session.
- Chromium's own (limited) media session is disabled via
  `--disable-features=MediaSessionService,HardwareMediaKeyHandling`; the plugin
  relaunches TIDAL once with this flag if needed.

## Settings

- **Optimize startup (avoid restarts)** — writes the flag into TIDAL's autostart
  command so every launch already carries it (no relaunch after the first time).
  Reversible by turning the toggle off.

## Notes

- Windows only. TIDAL desktop is 32-bit Electron; the embedded addon targets
  `i686-pc-windows-msvc`.
