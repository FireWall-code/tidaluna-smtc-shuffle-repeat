import { Tracer, type LunaUnload } from "@luna/core";
import { observe, redux } from "@luna/lib";

import { isRightToLeft, sameLanguage } from "./languages";
import { collectSourceLines, renderLyrics } from "./lyrics";
import { partsFor, type LinePart } from "./modes";
import { settings, Settings } from "./Settings";
import { romanizeLines, translateLines } from "./translator";

export const { trace, errSignal } = Tracer("[LyricsTranslate]");
export const unloads = new Set<LunaUnload>();
export { Settings };

// Lyrics payloads keyed by track + the settings that shaped them, so flipping back
// and forth (or replaying a track) costs nothing.
const CACHE_LIMIT = 50;
const cache = new Map<string, redux.Lyrics>();

const cacheKey = (trackId: redux.ItemId) =>
	[trackId, settings.targetLanguage, settings.displayMode, settings.layout, settings.inlineSeparator, settings.skipSameLanguage].join("|");

const cacheGet = (trackId: redux.ItemId) => cache.get(cacheKey(trackId));
const cacheSet = (trackId: redux.ItemId, lyrics: redux.Lyrics) => {
	cache.set(cacheKey(trackId), lyrics);
	if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
};

/** Called by the settings page: previous renders no longer match the new settings. */
export const clearCache = () => {
	cache.clear();
	translated = null;
	if (showing === "translated" && original !== null) void showOriginal();
	updateButtons();
};

let original: redux.Lyrics | null = null;
let translated: redux.Lyrics | null = null;
let showing: "original" | "translated" = "original";
let busy = false;
// Set while we push our own lyrics payloads so the interceptors below ignore them.
let selfDispatch = false;

const dispatchLyrics = async (lyrics: redux.Lyrics) => {
	selfDispatch = true;
	try {
		// TIDAL only re-renders the lyrics view when the payload transitions, so clear it first.
		await redux.actions["content/LOAD_ITEM_LYRICS_FAIL"]({ itemId: lyrics.trackId });
		await redux.actions["content/LOAD_ITEM_LYRICS_SUCCESS"](lyrics);
	} finally {
		selfDispatch = false;
	}
};

const buildTranslation = async (lyrics: redux.Lyrics): Promise<redux.Lyrics | null> => {
	const sources = collectSourceLines(lyrics);
	if (sources.length === 0) return null;

	const parts = partsFor(settings.displayMode);
	const targetLang = settings.targetLanguage;

	const romanization = new Map<string, string>();
	const translation = new Map<string, string>();
	let detected: string | undefined;

	if (parts.includes("romanization")) {
		const result = await romanizeLines(sources, { targetLang });
		detected ??= result.src;
		sources.forEach((source, i) => romanization.set(source, result.lines[i]));
	}

	if (parts.includes("translation")) {
		const result = await translateLines(sources, {
			targetLang,
			abortOnSource: (src) => settings.skipSameLanguage && sameLanguage(src, targetLang),
		});
		detected ??= result.src;
		if (result.aborted) {
			trace.log(`Skipping translation, lyrics are already in ${targetLang}`);
			return null;
		}
		sources.forEach((source, i) => translation.set(source, result.lines[i]));
	}

	trace.log(`Rendered ${sources.length} lines as ${settings.displayMode} (detected source: ${detected ?? "unknown"})`);

	const resolve = (part: LinePart, source: string) => {
		if (part === "romanization") return romanization.get(source) ?? source;
		if (part === "translation") return translation.get(source) ?? source;
		return source;
	};

	const rendered = renderLyrics(lyrics, {
		parts,
		layout: settings.layout,
		separator: settings.inlineSeparator,
		resolve,
	});

	// Only force RTL when the line is purely target-language text; mixed lines read
	// better left to right, and the original's own direction still applies to it.
	const onlyTranslation = parts.length === 1 && parts[0] === "translation";
	return { ...rendered, isRightToLeft: onlyTranslation ? isRightToLeft(targetLang) : lyrics.isRightToLeft };
};

const showTranslation = async () => {
	if (original === null || busy) return;
	const source = original;

	if (translated === null) translated = cacheGet(source.trackId) ?? null;
	if (translated !== null) {
		showing = "translated";
		updateButtons();
		await dispatchLyrics(translated);
		return;
	}

	busy = true;
	updateButtons();
	try {
		const result = await buildTranslation(source);
		// The track changed while we were translating — drop the stale result.
		if (original?.trackId !== source.trackId) return;
		if (result === null) return;

		cacheSet(source.trackId, result);
		translated = result;
		showing = "translated";
		await dispatchLyrics(result);
	} catch (err) {
		trace.msg.err.withContext("Failed to translate lyrics")(err);
	} finally {
		busy = false;
		updateButtons();
	}
};

const showOriginal = async () => {
	if (original === null) return;
	showing = "original";
	updateButtons();
	await dispatchLyrics(original);
};

const toggle = () => (showing === "translated" ? showOriginal() : showTranslation());

redux.intercept("content/LOAD_ITEM_LYRICS_SUCCESS", unloads, (payload) => {
	if (selfDispatch) return;

	original = payload;
	translated = null;
	showing = "original";
	updateButtons();

	if (!settings.autoTranslate) return;

	const cached = cacheGet(payload.trackId);
	if (cached !== undefined) {
		// Already translated once: swap it in instead of flashing the original.
		translated = cached;
		showing = "translated";
		queueMicrotask(() => void dispatchLyrics(cached));
		updateButtons();
		return true;
	}
	// Otherwise let the original render now and swap it out when the translation lands.
	void showTranslation();
});

redux.intercept("content/LOAD_ITEM_LYRICS_FAIL", unloads, () => {
	if (selfDispatch) return;
	original = null;
	translated = null;
	showing = "original";
	updateButtons();
});

// --- Toolbar button ---------------------------------------------------------

const BUTTON_CLASS = "luna-lyrics-translate-button";
const buttons = new Set<HTMLButtonElement>();

const buttonLabel = () => {
	if (busy) return "Translating…";
	return showing === "translated" ? "Show original" : "Translate lyrics";
};

const updateButtons = () => {
	for (const button of buttons) {
		const label = buttonLabel();
		button.innerText = label;
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
		button.disabled = busy || original === null;
		button.style.display = settings.showButton ? "" : "none";
	}
};

// The lyrics view has no stable hook of its own, so the button is planted next to
// the fullscreen toggle and inherits its styling.
observe<HTMLElement>(unloads, '[data-test="request-fullscreen"]', (fullscreenButton) => {
	const parent = fullscreenButton.parentElement;
	if (parent === null || parent.querySelector(`.${BUTTON_CLASS}`) !== null) return;

	const button = document.createElement("button");
	button.className = `${fullscreenButton.classList.toString()} ${BUTTON_CLASS}`;
	button.addEventListener("click", () => void toggle());
	buttons.add(button);
	parent.insertBefore(button, fullscreenButton.nextSibling);
	updateButtons();
});

unloads.add(() => {
	for (const button of buttons) button.remove();
	buttons.clear();
});
