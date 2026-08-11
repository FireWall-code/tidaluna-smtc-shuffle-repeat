export type ActionData = Record<string, unknown>;
export type ActionResponse = Record<string, unknown> | void | unknown;
export type ActionHandler = (data: ActionData) => ActionResponse | Promise<ActionResponse>;

export interface ActionSchema {
	param?: string;
	validate: (value: unknown) => boolean;
}

export interface WsSubscription {
	fields: Set<string>;
	all: boolean;
	isAlive: boolean;
}

export interface WsMessage extends ActionData {
	action: string;
	fields?: string[];
	all?: boolean;
	mode?: number;
	shuffle?: boolean;
	time?: number;
	volume?: string | number;
	itemId?: string;
}

export interface ActionResult {
	success: boolean;
	response?: Record<string, unknown>;
}

/**
 * A REST route mapping an HTTP method + path pattern to a renderer action.
 * `pattern` is matched against the pathname; `:name` segments are captured
 * into `data` under that key. Query-string params are also merged into `data`.
 */
export interface Route {
	method: "GET" | "POST" | "PUT" | "DELETE";
	pattern: string;
	action: string;
}

/** Normalized, Spotify-Web-API-style track object returned by read endpoints. */
export interface ApiTrack {
	id: string;
	type: "track";
	name: string;
	duration_ms: number;
	track_number?: number;
	disc_number?: number;
	explicit?: boolean;
	popularity?: number;
	isrc?: string;
	audio_quality?: string;
	url?: string;
	artists: { id: string | number; name: string }[];
	album?: { id: string | number; title: string; cover?: string };
	cover?: string;
}
