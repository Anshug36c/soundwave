# SoundWave 🎵

A Spotify-style music streaming web app — search millions of songs, build playlists,
follow artists, read lyrics, and listen offline. Local-first: no account, no tracking,
everything you save stays on your device.

**Live:** `https://soundwave-nh48.onrender.com/`

## Features

- **Search** — songs, albums, artists with debounced suggestions, typo tolerance
  ("did you mean"), filters (year, duration, language), exact-match ranking
- **Artists** — top tracks, full discography (169 songs for big names), follow/unfollow
- **Playback** — gapless-ish handoff, hot standby prefetch, queue (reorder, play-next),
  shuffle/repeat, sleep timer, playback speed, 10-band EQ + studio sound, visualizer
- **Library** — liked songs, local playlists (import/export JSON), followed artists,
  saved albums, history with "continue listening" + "most played", offline downloads
- **Lyrics** — plain + synchronized (LRC) line highlighting
- **Offline / PWA** — installable, service worker, explicit offline saves, offline banner
- **Privacy** — nothing uploaded; one-tap "erase all local data"; local-only diagnostics

## Stack

- **Client:** React 18 + Vite + Tailwind + Zustand + React Router (PWA via `client/public/sw.js`)
- **Server:** Node 20 + Express — scrapes/aggregates provider sites, proxies audio
  (multi-mirror failover, fastest-CDN ranking, circuit breakers, on-disk indexes)

### Providers (server-side)

| Source | Role |
|---|---|
| DJPunjab (djp) | Songs, albums, search index |
| DJJohal/DJRing (dj) | Songs, albums |
| Mr-Jatt (mrj) | Songs, artist pages |
| JioSaavn API (saavn) | Metadata + stream fallback |
| Tidal (tidal) | **~30s instant-preview starter only** — info/covers/full playback always come from the other sources |

## Quickstart

```bash
# server (port 5090 in dev; serves client/dist in production)
cd server && npm ci --omit=dev && PORT=5090 node --openssl-legacy-provider server.js

# client (dev)
cd client && npm ci --include=dev && npm run dev
```

`--openssl-legacy-provider` is required: Saavn URLs use DES-ECB decryption.

## Scripts

| Where | Command | What |
|---|---|---|
| `client/` | `npm run dev` | Vite dev server |
| `client/` | `npm test` | Vitest unit tests |
| `client/` | `npm run build` | Production build → `client/dist` |
| `server/` | `npm start` | Production server (serves `../client/dist`) |
| `server/` | `npm run dev` | Watch-mode server |

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `5090` | Server port |
| `VITE_API_URL` | `/api` | Client → API base (same-origin in prod) |

No secrets, no database. Server caches live in memory (+ `server/data/*.json` indexes).

## Project structure

```
client/           React app (pages/, components/, store/, hooks/, services/)
  public/sw.js    Service worker (shell + explicit offline audio only)
server/
  server.js       Express API + scrapers + audio proxy (~2000 lines)
  data/           Provider search indexes (gitignored, rebuilt on boot)
.github/workflows CI: server check+audit, client test+build+audit
```

## API overview

`GET /api/search?q=&type=` · `GET /api/suggest?q=` · `GET /api/artist-songs?name=` ·
`GET /api/song|album|artist/:source/:id` · `GET /api/audio?m=&quality=` ·
`GET /api/tidal-preview?title=&artist=` · `GET /api/lyrics?` · `GET /api/health` ·
`GET /api/sources`

## Privacy & license note

SoundWave is a demo built for learning — it plays audio hosted by third-party
provider sites. Respect artists and rights holders; support official releases.
