# TidalAPI

Exposes TIDAL playback, queue and library over **HTTP + WebSocket** for external control and
monitoring — a Spotify-Web-API-style surface running locally on port **`24123`**.

> **Credits** — Originally created by **[vMohammad](https://vmohammad.dev)**
> ([vMohammad24/luna-plugins/plugins/api](https://github.com/vMohammad24/luna-plugins/tree/master/plugins/api)),
> whose repository is now deprecated. Maintained and extended here by
> [FireWall](https://github.com/FireWall-code) with the original author credited.

## Settings

- **API Port** — listen port (default `24123`).
- **Bind address** — interface to listen on. `127.0.0.1` (default) = local only; `0.0.0.0` exposes it
  on your LAN.
- **Auth token** — optional. When set, every request must send it via
  `Authorization: Bearer <token>` or `?token=<token>`. Empty = no auth.

## HTTP API

CORS is enabled. All responses are JSON.

### State & info (GET)

| Endpoint                              | Description                                                   |
| ------------------------------------- | ------------------------------------------------------------ |
| `GET /`                               | Raw cached state dump (legacy; all subscribed fields).       |
| `GET /player`                         | Spotify-style player object (`is_playing`, `progress_ms`, `shuffle_state`, `repeat_state`, `volume`, `item`). |
| `GET /player/currently-playing`       | Currently playing track (normalized).                        |
| `GET /player/currently-playing/lyrics`| Lyrics for the current track.                                |
| `GET /player/queue`                   | `{ currently_playing, queue: [...] }` with full metadata.    |
| `GET /search?q=&type=&limit=`         | Search. `type` = comma list of `tracks,albums,artists,playlists`. |
| `GET /tracks/:id`                     | Track info (normalized).                                     |
| `GET /tracks/:id/lyrics`              | Lyrics for a track.                                          |
| `GET /albums/:id`                     | Album info.                                                  |
| `GET /albums/:id/items`               | Album tracks.                                                |
| `GET /artists/:id`                    | Artist info.                                                 |
| `GET /playlists/:id`                  | Playlist info.                                               |
| `GET /playlists/:id/items`            | Playlist tracks.                                             |
| `GET /me/tracks/contains?ids=`        | Map of `{ id: boolean }` — whether each track is favourited. |

### Controls

Legacy single-action endpoints (unchanged):

| Endpoint               | Body                  | Description                                     |
| ---------------------- | --------------------- | ----------------------------------------------- |
| `POST /pause`          | -                     | Pause playback                                  |
| `POST /resume`         | -                     | Resume playback                                 |
| `POST /toggle`         | -                     | Toggle play/pause                               |
| `POST /next`           | -                     | Skip to next track                              |
| `POST /previous`       | -                     | Go to previous track                            |
| `POST /seek`           | `{ "time": 120 }`     | Seek to position (seconds)                      |
| `POST /volume`         | `{ "volume": 50 }`    | Set volume (0-100, or "+10"/"-10" for relative) |
| `POST /setRepeatMode`  | `{ "mode": 0 }`       | Set repeat mode (0=Off, 1=All, 2=One)           |
| `POST /setShuffleMode` | `{ "shuffle": true }` | Enable/disable shuffle                          |
| `POST /playNext`       | `{ "itemId": "..." }` | Add item to play next                           |
| `POST /addToQueue`     | `{ "itemId": "..." }` | Add item to queue                               |

Extended (REST-style):

| Endpoint                    | Body                                          | Description                              |
| --------------------------- | --------------------------------------------- | ---------------------------------------- |
| `POST /player/play`         | `{ "itemId" \| "albumId" \| "playlistId" }`   | Play a track, album or playlist now.     |
| `POST /player/queue/jump`   | `{ "index": 3 }`                              | Jump to a queue index.                   |
| `POST /player/queue/remove` | `{ "index": 3 }`                              | Remove an item from the queue.           |
| `POST /me/tracks`           | `{ "ids": ["123", ...] }`                     | Add tracks to favourites (like).         |
| `DELETE /me/tracks`         | `{ "ids": ["123", ...] }`                     | Remove tracks from favourites (unlike).  |

**Response format** for control actions: `{ "type": "ok", ... }` / `{ "type": "error", "error": "..." }`.

## WebSocket API

Connect to `ws://localhost:24123` (append `?token=` if auth is enabled).

- `{ "action": "subscribe", "fields": ["playing", "track"], "all": false }` — subscribe to fields.
- `{ "action": "subscribe", "all": true }` — subscribe to everything.
- `{ "action": "unsubscribe" }`.
- Any control action (see HTTP) sent as `{ "action": "...", ... }`.
- Any read action (e.g. `{ "action": "getPlayer" }`, `{ "action": "search", "q": "daft punk" }`) —
  the result is returned as `{ "type": "ok", "action", "data" }`.

Connections are kept alive with a 30s ping/pong heartbeat.

### Subscribable fields

`playing`, `playTime`, `repeatMode`, `lastPlayStart`, `playQueue`, `shuffle`, `volume`,
`currentTime`, `album`, `artist`, `track`, `coverUrl`, `isrc`, `duration`, `bestQuality`.

## Extending

Other plugins can register custom actions:

```ts
import { registerAction } from "@plugin/TidalAPI"; // resolved by Luna at runtime

registerAction(unloads, "myAction", async (data) => {
	return { hello: data.name };
});
```
