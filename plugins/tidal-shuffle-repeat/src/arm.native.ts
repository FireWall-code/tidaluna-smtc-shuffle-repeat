// Runs in the Electron MAIN process (backend) — owns the TIDAL window, required
// for SMTC GetForWindow. Loads the napi-rs addon once and exposes thin async
// wrappers the renderer can call over Luna's IPC bridge.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NATIVE_IA32_BASE64 } from "./native-bin";

interface SmtcNative {
	hello(): string;
	findOwnWindow(): { hwnd: number; title: string };
	armShuffleRepeat(hwnd: number): string;
	pollRequests(): {
		shuffle: boolean | null;
		repeat: number | null;
		button: string | null;
		position: number | null;
	};
	setShuffleState(enabled: boolean): void;
	setRepeatState(tidalMode: number): void;
	updateMetadata(
		title: string,
		artist: string,
		album: string,
		coverUrl: string,
		albumArtist: string,
		trackNumber: number,
		albumTrackCount: number,
		genre: string,
	): void;
	setPlaying(playing: boolean): void;
	updateTimeline(positionSecs: number, durationSecs: number): void;
}

let native: SmtcNative | null = null;
function load(): SmtcNative {
	if (native) return native;
	// TIDAL desktop is 32-bit Electron (ia32). Decode the embedded addon, write
	// it to a temp file, and require it from there — fully self-contained, no
	// absolute paths, so the plugin is shareable.
	if (process.arch !== "ia32") {
		throw new Error(`unsupported arch ${process.arch} (only ia32 embedded)`);
	}
	const buf = Buffer.from(NATIVE_IA32_BASE64, "base64");
	const dir = path.join(os.tmpdir(), "smtc-bridge");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `smtc-bridge-ia32-${buf.length}.node`);
	if (!fs.existsSync(file) || fs.statSync(file).size !== buf.length) {
		fs.writeFileSync(file, buf);
	}
	const req = createRequire(file);
	native = req(file) as SmtcNative;
	return native;
}

const MEDIA_FLAG = "--disable-features=MediaSessionService,HardwareMediaKeyHandling";

/**
 * Ensure TIDAL is running with Chromium's media session disabled. If the flag
 * isn't already in argv, relaunch the app with it (one quick restart) so OUR
 * SMTC session becomes the only one. Returns relaunching=true if it triggered a
 * restart (caller should stop init in that case).
 */
export async function ensureChromiumDisabled(): Promise<{ relaunching: boolean; reason: string }> {
	try {
		if (process.argv.some((a) => a.includes("MediaSessionService"))) {
			return { relaunching: false, reason: "flag already active" };
		}
		const base = path.join(os.tmpdir(), "smtc-bridge", "resolver.js");
		const electron: any = createRequire(base)("electron");
		const args = process.argv.slice(1).filter((a) => !a.includes("MediaSessionService"));
		args.push(MEDIA_FLAG);
		electron.app.relaunch({ args });
		electron.app.exit(0);
		return { relaunching: true, reason: "relaunching with media flag" };
	} catch (e) {
		return { relaunching: false, reason: `could not relaunch: ${(e as Error)?.message ?? e}` };
	}
}

// --- Persistence: add the media flag to TIDAL's Squirrel autostart command so
// --- subsequent launches already carry it (no relaunch after the first time).
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function readRunCommand(): string | null {
	try {
		const out = execFileSync("reg", ["query", RUN_KEY, "/v", "TIDAL"], { encoding: "utf8" });
		const m = out.match(/TIDAL\s+REG_SZ\s+(.+)/);
		return m ? m[1].trim() : null;
	} catch {
		return null;
	}
}

function writeRunCommand(value: string): void {
	execFileSync("reg", ["add", RUN_KEY, "/v", "TIDAL", "/t", "REG_SZ", "/d", value, "/f"]);
}

/** Add the media flag to TIDAL's autostart command (idempotent). */
export async function persistFlag(): Promise<{ ok: boolean; detail: string }> {
	try {
		const cur = readRunCommand();
		if (!cur) return { ok: false, detail: "TIDAL autostart entry not found" };
		if (cur.includes("MediaSessionService")) return { ok: true, detail: "already persisted" };
		let next: string;
		if (cur.includes('--process-start-args "')) {
			next = cur.replace(
				/(--process-start-args ")([^"]*)(")/,
				(_m, a: string, inner: string, c: string) => `${a}${inner} ${MEDIA_FLAG}${c}`,
			);
		} else {
			next = `${cur} --process-start-args "${MEDIA_FLAG}"`;
		}
		writeRunCommand(next);
		return { ok: true, detail: "persisted into autostart" };
	} catch (e) {
		return { ok: false, detail: String((e as Error)?.message ?? e) };
	}
}

/** Remove the media flag from TIDAL's autostart command. */
export async function unpersistFlag(): Promise<{ ok: boolean; detail: string }> {
	try {
		const cur = readRunCommand();
		if (!cur || !cur.includes("MediaSessionService")) {
			return { ok: true, detail: "nothing to remove" };
		}
		let next = cur.replace(/\s*--disable-features=MediaSessionService,HardwareMediaKeyHandling/g, "");
		next = next.replace(/\s*--process-start-args ""/g, "");
		writeRunCommand(next);
		return { ok: true, detail: "removed from autostart" };
	} catch (e) {
		return { ok: false, detail: String((e as Error)?.message ?? e) };
	}
}

export interface ArmResult {
	ok: boolean;
	message: string;
	hwnd: number;
	title: string;
}

export async function armTest(): Promise<ArmResult> {
	try {
		const n = load();
		const win = n.findOwnWindow();
		if (!win || !win.hwnd) {
			return { ok: false, message: "no visible titled window found", hwnd: 0, title: win?.title ?? "" };
		}
		const message = n.armShuffleRepeat(win.hwnd);
		return { ok: true, message, hwnd: Number(win.hwnd), title: String(win.title) };
	} catch (e: unknown) {
		const err = e as { stack?: string } | undefined;
		return { ok: false, message: String(err?.stack ?? e), hwnd: 0, title: "" };
	}
}

/** Drain control requests coming FROM Windows (flyout / media keys). */
export async function pollRequests(): Promise<{
	shuffle: boolean | null;
	repeat: number | null;
	button: string | null;
	position: number | null;
}> {
	try {
		return load().pollRequests();
	} catch {
		return { shuffle: null, repeat: null, button: null, position: null };
	}
}

/** Push TIDAL's current shuffle/repeat state onto the SMTC session. */
export async function pushState(shuffle: boolean, repeat: number): Promise<void> {
	try {
		const n = load();
		n.setShuffleState(shuffle);
		n.setRepeatState(repeat);
	} catch {
		/* ignore */
	}
}

export async function updateMetadata(
	title: string,
	artist: string,
	album: string,
	coverUrl: string,
	albumArtist: string,
	trackNumber: number,
	albumTrackCount: number,
	genre: string,
): Promise<void> {
	try {
		load().updateMetadata(title, artist, album, coverUrl, albumArtist, trackNumber, albumTrackCount, genre);
	} catch {
		/* ignore */
	}
}

export async function setPlaying(playing: boolean): Promise<void> {
	try {
		load().setPlaying(playing);
	} catch {
		/* ignore */
	}
}

export async function updateTimeline(positionSecs: number, durationSecs: number): Promise<void> {
	try {
		load().updateTimeline(positionSecs, durationSecs);
	} catch {
		/* ignore */
	}
}
