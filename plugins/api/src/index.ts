import { LunaUnload, reduxStore, Tracer } from "@luna/core";
import { ipcRenderer, MediaItem, PlayState, redux, safeInterval, TidalApi } from "@luna/lib";
import { startServer, stopServer, updateFields } from "./index.native";
import { settings } from "./Settings";
import type { ActionData, ActionHandler, ApiTrack } from "./types";

declare global {
	interface Window {
		__apiInvokeAction?: (data: ActionData & { action: string }) => Promise<unknown>;
	}
}

const stateUpdateInt = 250;
const portCheckInt = 5000;

export const { trace } = Tracer("[API]");
export const unloads = new Set<LunaUnload>();
export { Settings } from "./Settings";

// #region Normalization (Spotify-Web-API-style shapes)
const coverImg = (uuid?: string) =>
	uuid ? `https://resources.tidal.com/images/${uuid.replace(/-/g, "/")}/640x640.jpg` : undefined;

const repeatStateOf = (m: unknown): "off" | "context" | "track" => {
	const map: Record<string, "off" | "context" | "track"> = {
		"0": "off",
		"1": "context",
		"2": "track",
		OFF: "off",
		ALL: "context",
		SINGLE: "track",
	};
	return map[String(m)] ?? "off";
};

const normalizeTrack = (t: any): ApiTrack | undefined => {
	if (!t) return undefined;
	const artists = (t.artists ?? (t.artist ? [t.artist] : [])).map((a: any) => ({
		id: a?.id,
		name: a?.name,
	}));
	return {
		id: String(t.id),
		type: "track",
		name: t.title,
		duration_ms: typeof t.duration === "number" ? Math.round(t.duration * 1000) : 0,
		track_number: t.trackNumber,
		disc_number: t.volumeNumber,
		explicit: t.explicit,
		popularity: t.popularity,
		isrc: t.isrc ?? undefined,
		audio_quality: t.audioQuality,
		url: t.url,
		artists,
		album: t.album ? { id: t.album.id, title: t.album.title, cover: t.album.cover } : undefined,
		cover: coverImg(t.album?.cover),
	};
};

// Search/list endpoints often wrap items as { item, type }; unwrap defensively.
const unwrap = (x: any) => (x && x.item ? x.item : x);
const normalizeList = (items: any[] | undefined): ApiTrack[] =>
	(items ?? []).map((i) => normalizeTrack(unwrap(i))).filter(Boolean) as ApiTrack[];
// #endregion

// #region TIDAL helpers
const session = () => reduxStore.getState().session as { userId?: number; countryCode?: string };

/** Raw authenticated TIDAL request (TidalApi.fetch is GET-only/memoized). */
const tidalRequest = async (path: string, init?: RequestInit): Promise<Response> => {
	const headers = await TidalApi.getAuthHeaders();
	return fetch(`https://desktop.tidal.com/v1/${path}`, {
		...init,
		headers: { ...headers, ...(init?.headers ?? {}) },
	});
};
// #endregion

// #region State pushing (powers GET / and WS field subscriptions)
const updateMediaFields = async (item: MediaItem | undefined) => {
	if (!item) return;

	const [album, artist, coverUrl, isrc] = await Promise.all([
		item.album(),
		item.artist(),
		item.coverUrl(),
		item.isrc(),
	]);

	updateFields({
		album: album?.tidalAlbum,
		artist: artist?.tidalArtist,
		track: item.tidalItem,
		coverUrl,
		isrc,
		duration: item.duration,
		bestQuality: item.bestQuality,
	});
};

const updateStateFields = () => {
	const { playing, playTime, repeatMode, lastPlayStart, playQueue, shuffle, currentTime } = PlayState;
	const { playbackControls } = redux.store.getState();

	const state: Record<string, unknown> = { playing, playTime, repeatMode, playQueue, shuffle };

	if (!Number.isNaN(currentTime)) state.currentTime = currentTime;
	if (lastPlayStart && !Number.isNaN(lastPlayStart)) state.lastPlayStart = lastPlayStart;
	if (playbackControls.volume) state.volume = playbackControls.volume;

	updateFields(state);
};
// #endregion

// #region Control helpers
const setVolume = (volume: number) => {
	redux.actions["playbackControls/SET_VOLUME"]({ volume });
};

const handleVolumeChange = (volume: string | number) => {
	if (typeof volume === "string" && /^[-+]\d+$/.test(volume)) {
		const currentVol = reduxStore.getState().playbackControls.volume || 0;
		const newVol = Math.max(0, Math.min(100, currentVol + Number.parseInt(volume, 10)));
		setVolume(newVol);
	} else if (typeof volume === "number" && volume >= 0 && volume <= 100) {
		setVolume(volume);
	}
};

const addToQueue = (itemId: string) => {
	redux.actions["playQueue/ADD_LAST"]({
		context: { type: "UNKNOWN", id: itemId },
		mediaItemIds: [itemId],
	});
};
// #endregion

// #region Read handlers (return data, surfaced via REST GET / WS)
// Resolve via TidalApi (fast) rather than MediaItem.fromPlaybackContext(),
// which can hang when invoked on-demand from the native bridge.
const currentTrackId = (): string | undefined => {
	const id = PlayState.playbackContext?.actualProductId;
	return id === undefined || id === null ? undefined : String(id);
};

const getCurrentlyPlaying = async () => {
	const id = currentTrackId();
	if (!id) return undefined;
	return normalizeTrack(await TidalApi.track(id));
};

const getPlayer = async () => {
	const { playbackControls } = redux.store.getState();
	return {
		is_playing: PlayState.playing,
		progress_ms: Math.round((PlayState.currentTime || 0) * 1000),
		shuffle_state: PlayState.shuffle,
		repeat_mode: PlayState.repeatMode,
		repeat_state: repeatStateOf(PlayState.repeatMode),
		volume: playbackControls.volume,
		item: await getCurrentlyPlaying(),
	};
};

const getQueue = async (limit = 50) => {
	const pq = PlayState.playQueue;
	const elements = pq.elements ?? [];
	const idx = pq.currentIndex ?? 0;
	const upcoming = elements.slice(idx + 1, idx + 1 + limit);
	const queue = await Promise.all(
		upcoming.map((e: any) =>
			e?.mediaItemId
				? TidalApi.track(e.mediaItemId)
						.then(normalizeTrack)
						.catch(() => undefined)
				: Promise.resolve(undefined),
		),
	);
	return {
		currently_playing: await getCurrentlyPlaying(),
		queue: queue.filter(Boolean),
	};
};

const getTrack = async (id: string) => {
	const t = await TidalApi.track(id);
	return normalizeTrack(t);
};

const getLyrics = async (id?: string) => {
	const trackId = id ?? currentTrackId();
	if (trackId === undefined) return undefined;
	return TidalApi.lyrics(trackId);
};

const search = async (data: ActionData) => {
	const query = String(data.q ?? data.query ?? "").trim();
	if (!query) return { error: "Missing query" };
	const limit = Number(data.limit ?? 20);
	const typesIn = String(data.type ?? data.types ?? "tracks,albums,artists,playlists");
	const types = typesIn
		.split(",")
		.map((t) => t.trim().toUpperCase())
		.map((t) => (t.endsWith("S") ? t : `${t}S`))
		.join(",");
	const res = await TidalApi.fetch<any>(
		`https://desktop.tidal.com/v1/search?query=${encodeURIComponent(query)}&limit=${limit}&types=${types}&includeContributors=true&${TidalApi.queryArgs()}`,
	);
	if (!res) return { tracks: [], albums: [], artists: [], playlists: [] };
	return {
		tracks: normalizeList(res.tracks?.items),
		albums: (res.albums?.items ?? []).map(unwrap),
		artists: (res.artists?.items ?? []).map(unwrap),
		playlists: (res.playlists?.items ?? []).map(unwrap),
	};
};

const isLiked = async (data: ActionData) => {
	const ids = String(data.ids ?? data.itemId ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const { userId, countryCode } = session();
	if (userId === undefined) return { error: "No user session" };
	const res = await tidalRequest(`users/${userId}/favorites/ids?countryCode=${countryCode}`).then((r) => (r.ok ? r.json() : null));
	const favTracks: string[] = (res?.TRACK ?? []).map((x: any) => String(x));
	const favSet = new Set(favTracks);
	return Object.fromEntries(ids.map((id) => [id, favSet.has(id)]));
};
// #endregion

// #region Mutating handlers
const playContext = async (data: ActionData) => {
	const { albumId, playlistId, itemId } = data as Record<string, string>;
	if (itemId) {
		PlayState.play(itemId);
		return { played: "track", itemId };
	}
	if (albumId) {
		const items = await TidalApi.albumItems(albumId);
		const ids = (items ?? []).map((i: any) => String(unwrap(i)?.id)).filter(Boolean);
		if (!ids.length) return { error: "Album has no playable items" };
		PlayState.playNext(ids);
		PlayState.next();
		PlayState.play();
		return { played: "album", albumId, count: ids.length };
	}
	if (playlistId) {
		const res = await TidalApi.playlistItems(playlistId);
		const ids = (res?.items ?? []).map((i: any) => String(unwrap(i)?.id)).filter(Boolean);
		if (!ids.length) return { error: "Playlist has no playable items" };
		PlayState.playNext(ids);
		PlayState.next();
		PlayState.play();
		return { played: "playlist", playlistId, count: ids.length };
	}
	return { error: "Provide itemId, albumId or playlistId" };
};

const queueJump = (data: ActionData) => {
	if (typeof data.index !== "number") return { error: "index must be a number" };
	PlayState.moveTo(data.index);
	return { jumped: data.index };
};

const queueRemove = (data: ActionData) => {
	if (typeof data.index !== "number") return { error: "index must be a number" };
	redux.actions["playQueue/REMOVE_AT_INDEX"]({ index: data.index });
	return { removed: data.index };
};

const likeTracks = (data: ActionData) => {
	const ids = (Array.isArray(data.ids) ? data.ids : String(data.ids ?? data.itemId ?? "").split(","))
		.map((s) => String(s).trim())
		.filter(Boolean);
	if (!ids.length) return { error: "Provide ids" };
	redux.actions["content/ADD_MEDIA_ITEM_IDS_TO_FAVORITES"]({ from: "heart", mediaItemIds: ids, forceFavorite: true });
	return { liked: ids };
};

const unlikeTracks = async (data: ActionData) => {
	const ids = (Array.isArray(data.ids) ? data.ids : String(data.ids ?? data.itemId ?? "").split(","))
		.map((s) => String(s).trim())
		.filter(Boolean);
	if (!ids.length) return { error: "Provide ids" };
	const { userId, countryCode } = session();
	if (userId === undefined) return { error: "No user session" };
	await Promise.all(
		ids.map((id) => tidalRequest(`users/${userId}/favorites/tracks/${id}?countryCode=${countryCode}`, { method: "DELETE" })),
	);
	return { unliked: ids };
};
// #endregion

const rendererActions: Record<string, (data: ActionData) => unknown> = {
	// --- transport controls ---
	pause: PlayState.pause,
	resume: () => PlayState.play(),
	toggle: () => (PlayState.playing ? PlayState.pause() : PlayState.play()),
	next: PlayState.next,
	previous: PlayState.previous,
	setRepeatMode: (data) => typeof data.mode === "number" && PlayState.setRepeatMode(data.mode),
	setShuffleMode: (data) => {
		if (typeof data.shuffle === "boolean") {
			data.shuffle ? PlayState.setShuffle(true, true) : PlayState.setShuffle(false, true);
		}
	},
	seek: (data) => typeof data.time === "number" && PlayState.seek(data.time),
	volume: (data) => handleVolumeChange(data.volume as string | number),
	playNext: (data) => data.itemId && PlayState.playNext(data.itemId as string),
	addToQueue: (data) => data.itemId && addToQueue(data.itemId as string),
	// --- extended controls ---
	play: (data) => playContext(data),
	queueJump: (data) => queueJump(data),
	queueRemove: (data) => queueRemove(data),
	like: (data) => likeTracks(data),
	unlike: (data) => unlikeTracks(data),
	// --- read endpoints ---
	getPlayer: () => getPlayer(),
	getCurrentlyPlaying: () => getCurrentlyPlaying(),
	getQueue: () => getQueue(),
	getTrack: (data) => getTrack(String(data.id ?? data.itemId)),
	getLyrics: (data) => getLyrics(data.id as string | undefined),
	getAlbum: (data) => TidalApi.album(String(data.id)),
	getAlbumItems: async (data) => normalizeList(await TidalApi.albumItems(String(data.id))),
	getArtist: (data) => TidalApi.artist(String(data.id)),
	getPlaylist: (data) => TidalApi.playlist(String(data.id)),
	getPlaylistItems: async (data) => normalizeList((await TidalApi.playlistItems(String(data.id)))?.items),
	search: (data) => search(data),
	isLiked: (data) => isLiked(data),
};

startServer(settings.port, settings.host, settings.token);
unloads.add(stopServer.bind(null));

let lastPort = settings.port;
let lastHost = settings.host;
let lastToken = settings.token;
safeInterval(
	unloads,
	() => {
		if (settings.port !== lastPort || settings.host !== lastHost || settings.token !== lastToken) {
			lastPort = settings.port;
			lastHost = settings.host;
			lastToken = settings.token;
			stopServer().then(() => {
				startServer(settings.port, settings.host, settings.token);
				trace.msg.log("Restarted server on", `${settings.host}:${settings.port}`);
			});
		}
	},
	portCheckInt,
);

MediaItem.fromPlaybackContext().then(updateMediaFields);
MediaItem.onMediaTransition(unloads, updateMediaFields);
PlayState.onState(unloads, updateStateFields);
safeInterval(unloads, updateStateFields, stateUpdateInt);

window.__apiInvokeAction = async (data: ActionData & { action: string }) => {
	const handler = rendererActions[data.action];
	if (handler) {
		const result = await handler(data);
		updateStateFields();
		return result;
	}
	return undefined;
};
unloads.add(() => {
	delete window.__apiInvokeAction;
});

ipcRenderer.on(unloads, "api.playback.control", async (data) => {
	await rendererActions[data.action]?.(data);
	updateStateFields();
});

/**
 * Register a new action handler for the API.
 * @param unloadsFn - Your plugin unloads set
 * @param name - The action name (used in HTTP/WebSocket requests)
 * @param handler - The function to execute when the action is triggered
 * @returns A function to unregister the action (same one is added to unloadsFn so do NOT call it manually unless you want to remove it early)
 */
export const registerAction = (unloadsFn: Set<LunaUnload>, name: string, handler: ActionHandler) => {
	if (rendererActions[name]) {
		trace.msg.warn(`Action "${name}" already exists, overwriting`);
	}
	let registered = true;
	rendererActions[name] = handler;
	const unregister = () => {
		if (registered) {
			registered = false;
			delete rendererActions[name];
		}
	};
	unloadsFn.add(unregister);
	unloads.add(unregister);
	return unregister;
};

export type { ActionData, ActionHandler } from "./types";
export { updateFields as updateAPIFields };
