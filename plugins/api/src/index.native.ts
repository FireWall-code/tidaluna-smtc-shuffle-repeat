import { BrowserWindow } from "electron";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { ActionSchema, Route, WsMessage, WsSubscription } from "./types";

type NativeActionHandler = (data: WsMessage) => { success: boolean; response?: Record<string, unknown> };

const ipcChannel = "api.playback.control";
const heartbeatInt = 30000;

// REST routes (matched top-to-bottom — list more specific paths first).
const routes: Route[] = [
	{ method: "GET", pattern: "/player/currently-playing/lyrics", action: "getLyrics" },
	{ method: "GET", pattern: "/player/currently-playing", action: "getCurrentlyPlaying" },
	{ method: "GET", pattern: "/player/queue", action: "getQueue" },
	{ method: "GET", pattern: "/player", action: "getPlayer" },
	{ method: "GET", pattern: "/search", action: "search" },
	{ method: "GET", pattern: "/tracks/:id/lyrics", action: "getLyrics" },
	{ method: "GET", pattern: "/tracks/:id", action: "getTrack" },
	{ method: "GET", pattern: "/albums/:id/items", action: "getAlbumItems" },
	{ method: "GET", pattern: "/albums/:id", action: "getAlbum" },
	{ method: "GET", pattern: "/artists/:id", action: "getArtist" },
	{ method: "GET", pattern: "/playlists/:id/items", action: "getPlaylistItems" },
	{ method: "GET", pattern: "/playlists/:id", action: "getPlaylist" },
	{ method: "GET", pattern: "/me/tracks/contains", action: "isLiked" },
	{ method: "POST", pattern: "/player/play", action: "play" },
	{ method: "POST", pattern: "/player/queue/jump", action: "queueJump" },
	{ method: "POST", pattern: "/player/queue/remove", action: "queueRemove" },
	{ method: "POST", pattern: "/me/tracks", action: "like" },
	{ method: "DELETE", pattern: "/me/tracks", action: "unlike" },
];

// Legacy single-segment POST control actions keep a fast validated path.
const schemas: Record<string, ActionSchema> = {
	setRepeatMode: { param: "mode", validate: (v): v is number => typeof v === "number" },
	setShuffleMode: { param: "shuffle", validate: (v): v is boolean => typeof v === "boolean" },
	seek: { param: "time", validate: (v): v is number => typeof v === "number" },
	volume: {
		param: "volume",
		validate: (v): v is string | number =>
			(typeof v === "string" && /^[-+]\d+$/.test(v)) || (typeof v === "number" && v >= 0 && v <= 100),
	},
	playNext: { param: "itemId", validate: (v): v is string => typeof v === "string" && v.length > 0 },
	addToQueue: { param: "itemId", validate: (v): v is string => typeof v === "string" && v.length > 0 },
};

let server: Server | null = null;
let wss: WebSocketServer | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let serverToken = "";
const fields: Record<string, unknown> = {};
const wsSubscriptions = new Map<WebSocket, WsSubscription>();

// #region Renderer bridge
const sendToRenderer = (data: Record<string, unknown>) => {
	const tidalWindow = BrowserWindow.fromId(1);
	if (!tidalWindow) {
		console.warn("[API] sendToRenderer: No tidalWindow available");
		return;
	}
	tidalWindow.webContents.send(ipcChannel, data);
};

const invokeRenderer = async (data: Record<string, unknown>): Promise<{ success: boolean; response?: unknown }> => {
	const tidalWindow = BrowserWindow.fromId(1);
	if (!tidalWindow) {
		console.warn("[API] invokeRenderer: No tidalWindow available");
		return { success: false };
	}
	try {
		const response = await tidalWindow.webContents.executeJavaScript(`window.__apiInvokeAction?.(${JSON.stringify(data)})`);
		return { success: true, response };
	} catch (e) {
		console.error("[API] invokeRenderer error:", e);
		return { success: false };
	}
};
// #endregion

// #region Auth
const extractToken = (req: IncomingMessage): string => {
	const auth = req.headers["authorization"];
	if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
	try {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		return url.searchParams.get("token") ?? "";
	} catch {
		return "";
	}
};

const isAuthed = (req: IncomingMessage): boolean => !serverToken || extractToken(req) === serverToken;
// #endregion

// #region Route matching
const matchRoute = (method: string, pathname: string): { route: Route; params: Record<string, string> } | null => {
	const reqSegs = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
	for (const route of routes) {
		if (route.method !== method) continue;
		const patSegs = route.pattern.split("/").filter(Boolean);
		if (patSegs.length !== reqSegs.length) continue;
		const params: Record<string, string> = {};
		let ok = true;
		for (let i = 0; i < patSegs.length; i++) {
			if (patSegs[i].startsWith(":")) params[patSegs[i].slice(1)] = decodeURIComponent(reqSegs[i]);
			else if (patSegs[i] !== reqSegs[i]) {
				ok = false;
				break;
			}
		}
		if (ok) return { route, params };
	}
	return null;
};
// #endregion

// #region WebSocket
const sendWsResponse = (ws: WebSocket, payload: Record<string, unknown>) => ws.send(JSON.stringify(payload));
const sendWsError = (ws: WebSocket, error: string) => sendWsResponse(ws, { type: "error", error });

const createActionHandler = (schema: ActionSchema): NativeActionHandler => {
	return (data) => {
		const paramValue = data[schema.param as keyof WsMessage];
		if (!schema.validate(paramValue)) return { success: false };
		const payload = { action: data.action, [schema.param!]: paramValue };
		sendToRenderer(payload);
		return { success: true, response: { type: "ok", ...payload } };
	};
};

const actionHandlers: Record<string, NativeActionHandler> = Object.fromEntries(
	Object.entries(schemas).map(([action, schema]) => [action, createActionHandler(schema)]),
);

const handleWsSubscribe = (ws: WebSocket, data: WsMessage): boolean => {
	if (!Array.isArray(data.fields) && !data.all) return false;
	const sub = wsSubscriptions.get(ws)!;
	sub.fields = new Set(data.fields ?? []);
	sub.all = !!data.all;
	sendWsResponse(ws, { type: "subscribed", fields: Array.from(sub.fields), all: sub.all });
	return true;
};

const handleWsUnsubscribe = (ws: WebSocket): void => {
	const sub = wsSubscriptions.get(ws)!;
	sub.fields.clear();
	sub.all = false;
	sendWsResponse(ws, { type: "unsubscribed" });
};

const handleWsMessage = async (ws: WebSocket, data: WsMessage) => {
	const { action } = data;

	if (action === "subscribe") {
		if (!handleWsSubscribe(ws, data)) sendWsError(ws, "Malformed subscribe action");
		return;
	}
	if (action === "unsubscribe") {
		handleWsUnsubscribe(ws);
		return;
	}

	const handler = actionHandlers[action];
	if (handler) {
		const result = handler(data);
		if (result.success && result.response) sendWsResponse(ws, result.response);
		else sendWsError(ws, `Malformed ${action} action`);
		return;
	}

	const result = await invokeRenderer({ ...data });
	if (result.success) sendWsResponse(ws, { type: "ok", action, data: result.response });
	else sendWsError(ws, `Action "${action}" failed or not found`);
};

const handleWsConnection = (ws: WebSocket, req: IncomingMessage) => {
	if (!isAuthed(req)) {
		sendWsError(ws, "Unauthorized");
		ws.close(1008, "Unauthorized");
		return;
	}
	wsSubscriptions.set(ws, { fields: new Set(), all: false, isAlive: true });

	ws.on("pong", () => {
		const sub = wsSubscriptions.get(ws);
		if (sub) sub.isAlive = true;
	});
	ws.on("message", (message: WebSocket.RawData) => {
		try {
			handleWsMessage(ws, JSON.parse(message.toString()) as WsMessage);
		} catch (e) {
			console.error("[API] WebSocket message error:", e);
			sendWsError(ws, "Invalid message format");
		}
	});
	ws.on("close", () => wsSubscriptions.delete(ws));
};

const notifyWebSocketClients = (field: string, value: unknown) => {
	if (!wss || fields[field] === value) return;
	for (const [ws, sub] of wsSubscriptions) {
		if (ws.readyState !== WebSocket.OPEN) continue;
		if (sub.all) sendWsResponse(ws, { type: "update", all: true, fields });
		else if (sub.fields.has(field)) sendWsResponse(ws, { type: "update", all: false, field, value });
	}
};
// #endregion

// #region HTTP
const sendHttpResponse = (res: ServerResponse, status: number, data: unknown) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
};

const parseRequestBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
	new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch {
				reject(new Error("Invalid JSON"));
			}
		});
		req.on("error", reject);
	});

// Reads return their data directly; an `{ error }` response maps to 400,
// `undefined` to 404, otherwise 200.
const sendRouted = (res: ServerResponse, response: unknown) => {
	if (response === undefined || response === null) {
		sendHttpResponse(res, 404, { type: "error", error: "Not found" });
		return;
	}
	if (typeof response === "object" && response !== null && "error" in (response as Record<string, unknown>)) {
		sendHttpResponse(res, 400, response);
		return;
	}
	sendHttpResponse(res, 200, response);
};

const handleLegacyAction = async (action: string, body: Record<string, unknown>, res: ServerResponse) => {
	if (!action) {
		sendHttpResponse(res, 400, { type: "error", error: "No action specified" });
		return;
	}
	const data: WsMessage = { action, ...body };
	const handler = actionHandlers[action];
	if (handler) {
		const result = handler(data);
		if (result.success && result.response) sendHttpResponse(res, 200, result.response);
		else sendHttpResponse(res, 400, { type: "error", error: `Malformed ${action} action` });
		return;
	}
	const result = await invokeRenderer({ ...data });
	if (result.success) sendHttpResponse(res, 200, { type: "ok", action, data: result.response });
	else sendHttpResponse(res, 400, { type: "error", error: `Action "${action}" failed or not found` });
};

const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse) => {
	for (const [k, v] of Object.entries({
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
	}))
		res.setHeader(k, v);

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (!isAuthed(req)) {
		sendHttpResponse(res, 401, { type: "error", error: "Unauthorized" });
		return;
	}

	const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
	const pathname = url.pathname;
	const method = req.method || "GET";
	const query = Object.fromEntries(url.searchParams.entries());

	// Backwards-compatible state dump.
	if (method === "GET" && (pathname === "/" || pathname === "")) {
		sendHttpResponse(res, 200, fields);
		return;
	}

	try {
		const matched = matchRoute(method, pathname);
		if (matched) {
			const body = method === "GET" ? {} : await parseRequestBody(req);
			const result = await invokeRenderer({ action: matched.route.action, ...query, ...body, ...matched.params });
			if (!result.success) {
				sendHttpResponse(res, 500, { type: "error", error: "Renderer invocation failed" });
				return;
			}
			sendRouted(res, result.response);
			return;
		}

		// Legacy: POST /<action> with JSON body.
		if (method === "POST") {
			await handleLegacyAction(pathname.slice(1), await parseRequestBody(req), res);
			return;
		}

		sendHttpResponse(res, 404, { type: "error", error: "Not found" });
	} catch (e) {
		sendHttpResponse(res, 400, { type: "error", error: e instanceof Error ? e.message : "Invalid request" });
	}
};
// #endregion

const updateField = (field: string, value: unknown) => {
	if (!server) {
		console.warn(`[API] Cannot update field "${field}": server not running`);
		return;
	}
	notifyWebSocketClients(field, value);
	fields[field] = value;
};

const startServer = async (port: number, host: string = "127.0.0.1", token: string = "") => {
	if (server) await stopServer();
	serverToken = token ?? "";

	server = createServer(handleHttpRequest);
	server.on("error", (e: NodeJS.ErrnoException) => {
		if (e.code === "EADDRINUSE") console.error(`[API] Port ${port} is already in use — server not started`);
		else console.error("[API] Server error:", e);
		server = null;
		wss = null;
	});
	server.listen(port, host, () => console.log(`[API] server running on ${host}:${port}`));

	wss = new WebSocketServer({ server });
	wss.on("connection", handleWsConnection);

	heartbeat = setInterval(() => {
		for (const [ws, sub] of wsSubscriptions) {
			if (!sub.isAlive) {
				ws.terminate();
				continue;
			}
			sub.isAlive = false;
			ws.ping();
		}
	}, heartbeatInt);
};

const stopServer = async () => {
	if (heartbeat) {
		clearInterval(heartbeat);
		heartbeat = null;
	}
	if (wss) {
		wss.clients.forEach((ws) => ws.close());
		wss.close();
		wss = null;
	}
	if (server) {
		server.close(() => {
			server = null;
			console.log("[API] server stopped");
		});
	}
};

const updateFields = (recordedFields: Record<string, unknown>) => {
	Object.entries(recordedFields).forEach(([key, value]) => updateField(key, value));
};

export { startServer, stopServer, updateFields };
