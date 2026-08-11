import { ftch } from "@luna/core";

export interface GoogleSentence {
	trans?: string;
	orig?: string;
	src_translit?: string;
}

export interface GoogleResponse {
	src?: string;
	sentences?: GoogleSentence[];
}

export interface TranslateOptions {
	/** Target language code. Ignored when `romanize` is set. */
	targetLang: string;
	/** Ask for a transliteration of the source instead of a translation. */
	romanize?: boolean;
	/**
	 * Checked once, after the first chunk comes back and the source language is known.
	 * Returning true stops the job early and yields the source lines untouched.
	 */
	abortOnSource?: (src: string) => boolean;
}

/** Lines already written in latin script have nothing to transliterate. */
const needsRomanization = (line: string) => /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(line);

/** Runs `task` over `items` with a bounded number of requests in flight. */
const pool = async <T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> => {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
};

export interface TranslateResult {
	lines: string[];
	/** Language Google detected for the source text, when it reported one. */
	src?: string;
	/** True when `abortOnSource` stopped the job and `lines` are the untouched source. */
	aborted: boolean;
}

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";

// The public gtx endpoint starts dropping content well before any URL limit, so
// jobs are cut into small chunks rather than sent as one blob.
const MAX_CHUNK_CHARS = 1200;
const MAX_CHUNK_LINES = 40;

const requestOnce = async (text: string, opts: TranslateOptions): Promise<{ text: string; src?: string }> => {
	const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: opts.targetLang, dj: "1", ie: "UTF-8", oe: "UTF-8" });
	params.append("dt", "t");
	if (opts.romanize) params.append("dt", "rm");

	// `q` goes in the body: lyrics regularly blow past what the endpoint accepts in a query string.
	const res = await ftch.json<GoogleResponse>(`${ENDPOINT}?${params}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
		body: new URLSearchParams({ q: text }).toString(),
	});

	const sentences = res.sentences ?? [];
	const pick = opts.romanize ? (s: GoogleSentence) => s.src_translit : (s: GoogleSentence) => s.trans;
	return { text: sentences.map((sentence) => pick(sentence) ?? "").join(""), src: res.src };
};

const request = async (text: string, opts: TranslateOptions) => {
	try {
		return await requestOnce(text, opts);
	} catch {
		// One retry: gtx rate limits sporadically and recovers immediately.
		await new Promise((resolve) => setTimeout(resolve, 400));
		return requestOnce(text, opts);
	}
};

const chunkLines = (lines: string[]): string[][] => {
	const chunks: string[][] = [];
	let chunk: string[] = [];
	let chars = 0;
	for (const line of lines) {
		if (chunk.length > 0 && (chunk.length >= MAX_CHUNK_LINES || chars + line.length > MAX_CHUNK_CHARS)) {
			chunks.push(chunk);
			chunk = [];
			chars = 0;
		}
		chunk.push(line);
		chars += line.length + 1;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
};

/**
 * Translates a chunk and guarantees one output line per input line.
 *
 * Google usually preserves the newlines it was given, but not always — and a single
 * dropped newline shifts every following line onto the wrong timestamp. So the line
 * count is verified, and a chunk that comes back misaligned is split in half and
 * retried until it lines up (worst case, one request per line).
 */
const translateChunk = async (lines: string[], opts: TranslateOptions, onSource: (src: string) => void): Promise<string[]> => {
	const { text, src } = await request(lines.join("\n"), opts);
	if (src !== undefined) onSource(src);

	const translated = text.split("\n");
	if (translated.length === lines.length) return translated.map((line, i) => line.trim() || lines[i]);

	if (lines.length === 1) return [text.replace(/\s*\n\s*/g, " ").trim() || lines[0]];

	const mid = Math.ceil(lines.length / 2);
	const head = await translateChunk(lines.slice(0, mid), opts, onSource);
	const tail = await translateChunk(lines.slice(mid), opts, onSource);
	return [...head, ...tail];
};

/**
 * Transliterates lines into latin script, one request per line.
 *
 * Unlike translations, Google returns the transliteration as a single blob with the
 * newlines stripped, so there is nothing to align a batched response against. Lines
 * that are already latin are skipped outright, and the rest go out through a small
 * pool rather than all at once.
 */
export const romanizeLines = async (lines: string[], opts: TranslateOptions): Promise<TranslateResult> => {
	let src: string | undefined;
	const romanized = await pool(lines, 5, async (line) => {
		if (!needsRomanization(line)) return line;
		try {
			const { text, src: detected } = await request(line, { ...opts, romanize: true });
			src ??= detected;
			return text.replace(/\s*\n\s*/g, " ").trim() || line;
		} catch {
			// A dropped line is better than a failed song: keep the original.
			return line;
		}
	});
	return { lines: romanized, src, aborted: false };
};

/** Translates lines, keeping a strict 1:1 mapping with the input. */
export const translateLines = async (lines: string[], opts: TranslateOptions): Promise<TranslateResult> => {
	if (lines.length === 0) return { lines: [], aborted: false };

	let src: string | undefined;
	const onSource = (detected: string) => (src ??= detected);

	const out: string[] = [];
	const chunks = chunkLines(lines);
	for (const [index, chunk] of chunks.entries()) {
		out.push(...(await translateChunk(chunk, opts, onSource)));
		// Bail out after the first chunk if the source turned out to be the target language.
		if (index === 0 && src !== undefined && opts.abortOnSource?.(src) === true) return { lines: [...lines], src, aborted: true };
	}
	return { lines: out, src, aborted: false };
};
