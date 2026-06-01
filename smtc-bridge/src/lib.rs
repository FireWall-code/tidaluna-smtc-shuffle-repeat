//! smtc-bridge — Phase 0
//!
//! Goal of this phase: prove the napi-rs + `windows` crate build pipeline works,
//! and that we can locate TIDAL's top-level window from inside its own process
//! (this addon will be loaded by TidaLuna's native layer, i.e. it runs *inside*
//! the TIDAL Electron process). The HWND is the handle we'll later hand to
//! `ISystemMediaTransportControlsInterop::GetForWindow` to (try to) arm
//! shuffle/repeat on the SMTC session.

#![deny(clippy::all)]

use napi_derive::napi;

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

/// Smoke test so we can confirm the .node loads from JS.
#[napi]
pub fn hello() -> String {
    "smtc-bridge alive".to_string()
}

#[napi(object)]
pub struct WinInfo {
    /// Window handle as a number (0 if none found).
    pub hwnd: i64,
    pub title: String,
}

struct FindCtx {
    pid: u32,
    hwnd: isize,
    title: String,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut FindCtx);

    let mut wpid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut wpid));

    if wpid == ctx.pid && IsWindowVisible(hwnd).as_bool() {
        let len = GetWindowTextLengthW(hwnd);
        if len > 0 {
            let mut buf = vec![0u16; (len + 1) as usize];
            let n = GetWindowTextW(hwnd, &mut buf);
            if n > 0 {
                ctx.hwnd = hwnd.0;
                ctx.title = String::from_utf16_lossy(&buf[..n as usize]);
                return BOOL(0); // found a titled, visible window -> stop enumerating
            }
        }
    }
    TRUE // keep going
}

/// Find the first visible, titled top-level window belonging to *this* process.
/// When loaded inside TIDAL, this should return the main TIDAL window.
#[napi]
pub fn find_own_window() -> WinInfo {
    let mut ctx = FindCtx {
        pid: unsafe { GetCurrentProcessId() },
        hwnd: 0,
        title: String::new(),
    };
    unsafe {
        // EnumWindows returns Err when the callback stops early; that's expected here.
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut _ as isize));
    }
    WinInfo {
        hwnd: ctx.hwnd as i64,
        title: ctx.title,
    }
}

// ---------------------------------------------------------------------------
// Phase 1: arm shuffle/repeat on the SMTC session for a given window.
//
// The decisive experiment: does GetForWindow(hwnd) on TIDAL's window hand us
// the SAME SMTC session Chromium already created (so flipping IsShuffleEnabled
// augments it), or a separate one? We arm it here, then observe with the
// PowerShell probe whether the TIDAL session's IsShuffleEnabled flips to True.
// ---------------------------------------------------------------------------

use std::sync::{Mutex, OnceLock};

use windows::core::{Result as WinResult, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler, Uri};
use windows::Media::{
    AutoRepeatModeChangeRequestedEventArgs, MediaPlaybackAutoRepeatMode, MediaPlaybackStatus,
    MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
    ShuffleEnabledChangeRequestedEventArgs, SystemMediaTransportControls,
    SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Storage::Streams::RandomAccessStreamReference;
use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

// HWND of the TIDAL window we bound to (so we can re-acquire the same SMTC).
static BOUND_HWND: OnceLock<isize> = OnceLock::new();

// Pending control requests coming FROM Windows (flyout / media keys), drained by
// the renderer via poll_requests(). repeat is stored as the TIDAL value already
// (0=off, 1=all, 2=one).
#[derive(Default)]
struct Pending {
    shuffle: Option<bool>,
    repeat: Option<i32>,
    button: Option<String>,
    position: Option<f64>,
}

fn pending() -> &'static Mutex<Pending> {
    static P: OnceLock<Mutex<Pending>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Pending::default()))
}

fn smtc_for(hwnd: isize) -> WinResult<SystemMediaTransportControls> {
    let interop = windows::core::factory::<
        SystemMediaTransportControls,
        ISystemMediaTransportControlsInterop,
    >()?;
    unsafe { interop.GetForWindow(HWND(hwnd)) }
}

// WinRT AutoRepeatMode -> TIDAL repeatMode int.
fn winrt_repeat_to_tidal(m: MediaPlaybackAutoRepeatMode) -> i32 {
    match m {
        MediaPlaybackAutoRepeatMode::List => 1,  // repeat all
        MediaPlaybackAutoRepeatMode::Track => 2, // repeat one
        _ => 0,                                  // None / off
    }
}

// TIDAL repeatMode int -> WinRT AutoRepeatMode.
fn tidal_repeat_to_winrt(m: i32) -> MediaPlaybackAutoRepeatMode {
    match m {
        1 => MediaPlaybackAutoRepeatMode::List,
        2 => MediaPlaybackAutoRepeatMode::Track,
        _ => MediaPlaybackAutoRepeatMode::None,
    }
}

fn arm_inner(hwnd: i64) -> WinResult<()> {
    let hwnd = hwnd as isize;
    let smtc = smtc_for(hwnd)?;

    smtc.SetIsEnabled(true)?;
    smtc.SetIsPlayEnabled(true)?;
    smtc.SetIsPauseEnabled(true)?;
    smtc.SetIsNextEnabled(true)?;
    smtc.SetIsPreviousEnabled(true)?;
    smtc.SetShuffleEnabled(false)?;
    smtc.SetAutoRepeatMode(MediaPlaybackAutoRepeatMode::None)?;

    // Registering these change-requested handlers is what advertises the
    // shuffle/repeat capability to consumers (FluentFlyout / Windows flyout).
    smtc.ShuffleEnabledChangeRequested(&TypedEventHandler::new(
        move |_s: &Option<SystemMediaTransportControls>,
              args: &Option<ShuffleEnabledChangeRequestedEventArgs>| {
            if let Some(a) = args {
                let v = a.RequestedShuffleEnabled()?;
                pending().lock().unwrap().shuffle = Some(v);
            }
            Ok(())
        },
    ))?;

    smtc.AutoRepeatModeChangeRequested(&TypedEventHandler::new(
        move |_s: &Option<SystemMediaTransportControls>,
              args: &Option<AutoRepeatModeChangeRequestedEventArgs>| {
            if let Some(a) = args {
                let m = a.RequestedAutoRepeatMode()?;
                pending().lock().unwrap().repeat = Some(winrt_repeat_to_tidal(m));
            }
            Ok(())
        },
    ))?;

    smtc.ButtonPressed(&TypedEventHandler::new(
        move |_s: &Option<SystemMediaTransportControls>,
              args: &Option<SystemMediaTransportControlsButtonPressedEventArgs>| {
            if let Some(a) = args {
                let name = match a.Button()? {
                    SystemMediaTransportControlsButton::Play => "play",
                    SystemMediaTransportControlsButton::Pause => "pause",
                    SystemMediaTransportControlsButton::Next => "next",
                    SystemMediaTransportControlsButton::Previous => "previous",
                    _ => "other",
                };
                pending().lock().unwrap().button = Some(name.to_string());
            }
            Ok(())
        },
    ))?;

    // Seek requests from the flyout's progress bar (TimeSpan is in 100ns ticks).
    smtc.PlaybackPositionChangeRequested(&TypedEventHandler::new(
        move |_s: &Option<SystemMediaTransportControls>,
              args: &Option<PlaybackPositionChangeRequestedEventArgs>| {
            if let Some(a) = args {
                let ts = a.RequestedPlaybackPosition()?;
                pending().lock().unwrap().position = Some(ts.Duration as f64 / 10_000_000.0);
            }
            Ok(())
        },
    ))?;

    let _ = BOUND_HWND.set(hwnd);
    Ok(())
}

/// Bind to the SMTC session of `hwnd`, enable transport + shuffle/repeat, and
/// register the change-requested / button handlers. Call once from inside TIDAL.
#[napi]
pub fn arm_shuffle_repeat(hwnd: i64) -> napi::Result<String> {
    arm_inner(hwnd)
        .map(|_| format!("armed shuffle/repeat + handlers on hwnd {hwnd}"))
        .map_err(|e| napi::Error::from_reason(format!("SMTC arm failed: {e:?}")))
}

#[napi(object)]
pub struct PendingRequests {
    pub shuffle: Option<bool>,
    pub repeat: Option<i32>,
    pub button: Option<String>,
    pub position: Option<f64>,
}

/// Drain any control requests received from Windows since the last poll.
/// The renderer should call this on a short interval and apply the values via
/// PlayState (setShuffle / setRepeatMode / play / pause / next / previous).
#[napi]
pub fn poll_requests() -> PendingRequests {
    let mut p = pending().lock().unwrap();
    PendingRequests {
        shuffle: p.shuffle.take(),
        repeat: p.repeat.take(),
        button: p.button.take(),
        position: p.position.take(),
    }
}

/// Push TIDAL's current shuffle state onto the SMTC so the flyout shows it.
#[napi]
pub fn set_shuffle_state(enabled: bool) -> napi::Result<()> {
    let hwnd = *BOUND_HWND.get().ok_or_else(|| napi::Error::from_reason("not armed"))?;
    smtc_for(hwnd)
        .and_then(|s| s.SetShuffleEnabled(enabled))
        .map_err(|e| napi::Error::from_reason(format!("{e:?}")))
}

/// Push TIDAL's current repeat mode (0=off,1=all,2=one) onto the SMTC.
#[napi]
pub fn set_repeat_state(tidal_mode: i32) -> napi::Result<()> {
    let hwnd = *BOUND_HWND.get().ok_or_else(|| napi::Error::from_reason("not armed"))?;
    smtc_for(hwnd)
        .and_then(|s| s.SetAutoRepeatMode(tidal_repeat_to_winrt(tidal_mode)))
        .map_err(|e| napi::Error::from_reason(format!("{e:?}")))
}

fn bound() -> napi::Result<isize> {
    BOUND_HWND
        .get()
        .copied()
        .ok_or_else(|| napi::Error::from_reason("not armed"))
}

fn win_err<T>(r: WinResult<T>) -> napi::Result<T> {
    r.map_err(|e| napi::Error::from_reason(format!("{e:?}")))
}

/// Publish now-playing metadata on the SMTC session. `cover_url` is an http(s)
/// URL to the album art (TIDAL cover); pass an empty string to skip.
#[napi]
pub fn update_metadata(
    title: String,
    artist: String,
    album: String,
    cover_url: String,
    album_artist: String,
    track_number: i32,
    album_track_count: i32,
    genre: String,
) -> napi::Result<()> {
    let smtc = smtc_for(bound()?).map_err(|e| napi::Error::from_reason(format!("{e:?}")))?;
    win_err((|| {
        let updater = smtc.DisplayUpdater()?;
        updater.SetType(MediaPlaybackType::Music)?;
        let music = updater.MusicProperties()?;
        music.SetTitle(&HSTRING::from(&title))?;
        music.SetArtist(&HSTRING::from(&artist))?;
        music.SetAlbumTitle(&HSTRING::from(&album))?;
        if !album_artist.is_empty() {
            music.SetAlbumArtist(&HSTRING::from(&album_artist))?;
        }
        if track_number > 0 {
            music.SetTrackNumber(track_number as u32)?;
        }
        if album_track_count > 0 {
            music.SetAlbumTrackCount(album_track_count as u32)?;
        }
        if !genre.is_empty() {
            music.Genres()?.Append(&HSTRING::from(&genre))?;
        }
        if !cover_url.is_empty() {
            let uri = Uri::CreateUri(&HSTRING::from(&cover_url))?;
            let stream = RandomAccessStreamReference::CreateFromUri(&uri)?;
            updater.SetThumbnail(&stream)?;
        }
        updater.Update()?;
        Ok(())
    })())
}

/// Set the SMTC playback status (true = Playing, false = Paused).
#[napi]
pub fn set_playing(playing: bool) -> napi::Result<()> {
    let smtc = smtc_for(bound()?).map_err(|e| napi::Error::from_reason(format!("{e:?}")))?;
    let status = if playing {
        MediaPlaybackStatus::Playing
    } else {
        MediaPlaybackStatus::Paused
    };
    win_err(smtc.SetPlaybackStatus(status))
}

/// Update the seekbar timeline (seconds).
#[napi]
pub fn update_timeline(position_secs: f64, duration_secs: f64) -> napi::Result<()> {
    let smtc = smtc_for(bound()?).map_err(|e| napi::Error::from_reason(format!("{e:?}")))?;
    let to_ts = |s: f64| TimeSpan {
        Duration: (s.max(0.0) * 10_000_000.0) as i64,
    };
    win_err((|| {
        let props = SystemMediaTransportControlsTimelineProperties::new()?;
        props.SetStartTime(to_ts(0.0))?;
        props.SetMinSeekTime(to_ts(0.0))?;
        props.SetPosition(to_ts(position_secs))?;
        props.SetMaxSeekTime(to_ts(duration_secs))?;
        props.SetEndTime(to_ts(duration_secs))?;
        smtc.UpdateTimelineProperties(&props)?;
        Ok(())
    })())
}
