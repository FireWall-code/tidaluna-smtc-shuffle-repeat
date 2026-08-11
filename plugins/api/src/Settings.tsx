import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaTextSetting } from "@luna/ui";
import React from "react";

export const settings = await ReactiveStore.getPluginStorage("api", {
	port: 24123,
	// Bind address. Defaults to loopback so the API is only reachable locally.
	// Set to "0.0.0.0" to expose it on the network (use a token if you do).
	host: "127.0.0.1",
	// Optional bearer token. When non-empty, every HTTP/WS request must supply
	// it via `Authorization: Bearer <token>` or `?token=<token>`.
	token: "",
});

// Tiny local debounce so we don't pull in @mui/material just for this.
const debounce = <A extends unknown[]>(fn: (...args: A) => void, ms: number) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (...args: A) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
};

export const Settings = () => {
	const [port, setPort] = React.useState(settings.port);
	const [host, setHost] = React.useState(settings.host);
	const [token, setToken] = React.useState(settings.token);

	const commitPort = React.useMemo(
		() =>
			debounce((newPort: number) => {
				if (Number.isNaN(newPort) || newPort < 1 || newPort > 65535) {
					setPort(settings.port);
					return;
				}
				settings.port = newPort;
			}, 500),
		[],
	);

	const commitHost = React.useMemo(
		() =>
			debounce((newHost: string) => {
				settings.host = newHost.trim() || "127.0.0.1";
			}, 500),
		[],
	);

	const commitToken = React.useMemo(
		() =>
			debounce((newToken: string) => {
				settings.token = newToken;
			}, 500),
		[],
	);

	return (
		<LunaSettings>
			<LunaTextSetting
				title="API Port"
				desc="The port the API server will listen on (defaults to 24123)"
				value={port}
				type="number"
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
					setPort(Number(e.target.value));
					commitPort(Number(e.target.value));
				}}
			/>
			<LunaTextSetting
				title="Bind address"
				desc="Network interface to listen on. 127.0.0.1 = local only (recommended). Use 0.0.0.0 to expose on your LAN."
				value={host}
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
					setHost(e.target.value);
					commitHost(e.target.value);
				}}
			/>
			<LunaTextSetting
				title="Auth token (optional)"
				desc="When set, requests must include 'Authorization: Bearer <token>' or '?token=<token>'. Leave empty to disable auth."
				value={token}
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
					setToken(e.target.value);
					commitToken(e.target.value);
				}}
			/>
		</LunaSettings>
	);
};
