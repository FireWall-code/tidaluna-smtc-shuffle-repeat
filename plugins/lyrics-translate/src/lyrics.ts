import type { redux } from "@luna/lib";
import type { Layout, LinePart } from "./modes";

// LRC lines look like `[00:12.34]text`, and may carry several timestamps at once.
const TIMESTAMPS = /^((?:\[[^\]]*\]\s*)+)(.*)$/;

export interface SubtitleLine {
	/** The `[mm:ss.xx]` prefix, empty for lines that carry no timestamp. */
	prefix: string;
	text: string;
}

export const parseSubtitleLine = (line: string): SubtitleLine => {
	const match = TIMESTAMPS.exec(line);
	if (match === null) return { prefix: "", text: line };
	return { prefix: match[1], text: match[2] };
};

/**
 * Every distinct line of text in a lyrics payload, from both the plain and the
 * synced view. Deduplicated: choruses repeat, and translating the same line five
 * times is five times the requests for the same answer.
 */
export const collectSourceLines = (lyrics: redux.Lyrics): string[] => {
	const seen = new Set<string>();
	const add = (line: string) => {
		const text = line.trim();
		if (text !== "") seen.add(text);
	};
	for (const line of (lyrics.lyrics ?? "").split("\n")) add(line);
	for (const line of (lyrics.subtitles ?? "").split("\n")) add(parseSubtitleLine(line).text);
	return [...seen];
};

export interface RenderOptions {
	parts: LinePart[];
	layout: Layout;
	/** Joins parts when `layout` is `inline`. */
	separator: string;
	/** Resolves one part of one source line. Returning the source line means "unchanged". */
	resolve: (part: LinePart, source: string) => string;
}

/** The parts of a rendered line, with empty and consecutive-duplicate parts dropped. */
const renderParts = (source: string, { parts, resolve }: RenderOptions): string[] => {
	const rendered: string[] = [];
	for (const part of parts) {
		const text = resolve(part, source).trim();
		if (text === "" || text === rendered[rendered.length - 1]) continue;
		rendered.push(text);
	}
	// Everything collapsed (e.g. translation identical to the original) — keep the line.
	return rendered.length > 0 ? rendered : [source];
};

const renderPlain = (lyrics: string, opts: RenderOptions): string =>
	lyrics
		.split("\n")
		.map((line) => {
			const source = line.trim();
			if (source === "") return line;
			// The unsynced view has room, so parts always get their own line there.
			return renderParts(source, opts).join("\n");
		})
		.join("\n");

const renderSubtitles = (subtitles: string, opts: RenderOptions): string =>
	subtitles
		.split("\n")
		.map((line) => {
			const { prefix, text } = parseSubtitleLine(line);
			const source = text.trim();
			if (source === "") return line;
			const rendered = renderParts(source, opts);
			// `inline` keeps one timestamp per line; `newline` repeats the timestamp so the
			// player still highlights both halves of a bilingual line at the same time.
			return opts.layout === "inline"
				? prefix + rendered.join(opts.separator)
				: rendered.map((part) => prefix + part).join("\n");
		})
		.join("\n");

export const renderLyrics = (lyrics: redux.Lyrics, opts: RenderOptions): redux.Lyrics => ({
	...lyrics,
	lyrics: renderPlain(lyrics.lyrics ?? "", opts),
	subtitles: lyrics.subtitles == null ? lyrics.subtitles : renderSubtitles(lyrics.subtitles, opts),
});
