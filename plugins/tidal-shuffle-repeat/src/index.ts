import { ReactiveStore, Tracer, type LunaUnload } from "@luna/core";
import { MediaItem, PlayState } from "@luna/lib";
import {
	armTest,
	ensureChromiumDisabled,
	persistFlag,
	pollRequests,
	pushState,
	setPlaying,
	updateMetadata,
	updateTimeline,
} from "./arm.native";

// Re-exports so the Settings page can import everything from "." (mirrors the
// official luna-template structure).
export { Settings } from "./Settings";
export { persistFlag, unpersistFlag } from "./arm.native";

export const settings = await ReactiveStore.getPluginStorage("TidalSmtcShuffleRepeat", {
	// When on, the Chromium-media-disable flag is written into TIDAL's autostart
	// so the feature works with no relaunch after the first time.
	optimizeStartup: false,
});

export const unloads = new Set<LunaUnload>();
export const { trace, errSignal } = Tracer("[SMTC]");

let lastShuffle: boolean | undefined;
let lastRepeat: number | undefined;
let lastPlaying: boolean | undefined;
let duration = 0;

const syncToSmtc = () => {
	const shuffle = PlayState.shuffle;
	const repeat = PlayState.repeatMode as unknown as number;
	if (shuffle !== lastShuffle || repeat !== lastRepeat) {
		lastShuffle = shuffle;
		lastRepeat = repeat;
		void pushState(shuffle, repeat);
	}
};

// Defensive metadata extraction (the @luna/lib accessors are async and shapes vary).
const pushMetadata = async (mi: any) => {
	try {
		const title = String((await mi?.title?.()) ?? "");
		let artist = "";
		try {
			const ar = await mi?.artists?.();
			if (Array.isArray(ar)) {
				const names = await Promise.all(
					ar.map(async (a: any) => {
						const v = await a;
						return typeof v?.name === "function" ? await v.name() : (v?.name ?? v);
					}),
				);
				artist = names.filter(Boolean).join(", ");
			} else artist = String(ar?.name ?? ar ?? "");
		} catch {
			/* ignore */
		}
		const albumRaw = await mi?.album?.();
		const album = String(albumRaw?.title ?? albumRaw ?? "");
		let cover = "";
		try {
			cover = String((await mi?.coverUrl?.(640)) ?? (await mi?.coverUrl?.()) ?? "");
		} catch {
			/* ignore */
		}
		await updateMetadata(title, artist, album, cover);
		try {
			const raw = typeof mi?.duration === "function" ? await mi.duration() : mi?.duration;
			const d = Number(raw);
			if (Number.isFinite(d) && d > 0) duration = d;
		} catch {
			/* ignore */
		}
	} catch (e) {
		trace.err.withContext("pushMetadata")(e as Error);
	}
};

ensureChromiumDisabled()
	.then((flag) => {
		if (flag.relaunching) {
			trace.log("Chromium media not disabled — relaunching TIDAL with flag…");
			return null;
		}
		// Keep the autostart entry patched if the user opted in (no relaunch next time).
		if (settings.optimizeStartup) {
			void persistFlag().then((p) => trace.log(`persist: ${p.detail}`));
		}
		return armTest();
	})
	.then(async (r) => {
		if (!r) return;
		if (!r.ok) {
			trace.err.withContext("armTest")(r.message);
			return;
		}
		trace.log(`ready — "${r.title}" hwnd ${r.hwnd}`);

		// Suppress Chromium's own (now-disabled) media session API as a fallback.
		try {
			const ms: any = (navigator as any).mediaSession;
			if (ms) {
				for (const a of [
					"play", "pause", "stop", "seekbackward", "seekforward",
					"previoustrack", "nexttrack", "seekto",
				]) {
					try { ms.setActionHandler(a, null); } catch {}
				}
				try { ms.metadata = null; } catch {}
				try { ms.playbackState = "none"; } catch {}
				try { ms.setActionHandler = () => {}; } catch {}
				try { Object.defineProperty(ms, "metadata", { configurable: true, get: () => null, set: () => {} }); } catch {}
				try { Object.defineProperty(ms, "playbackState", { configurable: true, get: () => "none", set: () => {} }); } catch {}
			}
		} catch {
			/* ignore */
		}

		syncToSmtc();
		MediaItem.onMediaTransition(unloads, (mi: unknown) => void pushMetadata(mi));

		const id = setInterval(async () => {
			syncToSmtc();

			const playing = PlayState.playing;
			if (playing !== lastPlaying) {
				lastPlaying = playing;
				void setPlaying(playing);
			}
			void updateTimeline(Number((PlayState as any).currentTime ?? 0), duration);

			let req;
			try {
				req = await pollRequests();
			} catch {
				return;
			}
			if (req.shuffle != null) PlayState.setShuffle(req.shuffle);
			if (req.repeat != null) PlayState.setRepeatMode(req.repeat as never);
			if (req.position != null) PlayState.seek(req.position);
			if (req.button === "play") PlayState.play();
			else if (req.button === "pause") PlayState.pause();
			else if (req.button === "next") PlayState.next();
			else if (req.button === "previous") PlayState.previous();
		}, 250);
		unloads.add(() => clearInterval(id));
	})
	.catch((e) => trace.err.withContext("init")(e));
