# 🎵 SoundWave — Spotify-like Music Streaming PWA

A fully functional music streaming web app with **real playback**, unified search across
multiple music APIs, playlists, lyrics, offline mode, and an installable PWA shell.

## ✨ Features

- **Home**: hero carousel, recently played, Made For You, trending, top artists, new releases, charts, mood bubbles
- **Search**: debounced unified search (JioSaavn full tracks + Deezer previews) with Songs/Albums/Artists/Playlists tabs, history + trending
- **Player**: persistent mini player + full-screen player (spinning vinyl, lyrics, details), queue, shuffle/repeat, volume, seek, sleep timer, offline save, share, Media Session API (lock-screen controls), keyboard shortcuts
- **Library**: liked songs, user playlists (create/rename/delete/reorder/remove, auto mosaic covers), saved albums, followed artists, offline songs, history
- **Detail pages**: album, artist (bio/tags/similar via LastFM when configured, 📻 radio mode), playlists, global charts
- **Settings/Profile**: display name, listening stats, top artists, theme (dark/light), audio quality (320kbps), offline cache management
- **PWA**: manifest + service worker (app-shell + audio caching, offline playback), installable
- **Backend aggregator**: Express proxy that unifies JioSaavn + iTunes + Deezer + Lyrics.ovh (+ AudioDB/LastFM enrichment), dedupes, caches, and resolves best stream with automatic fallback. Check live upstream status at `/api/sources`.

## 🏗 Tech stack

- Frontend: React 18 + Vite + Tailwind CSS v4 + Zustand + React Router
- Backend: Node.js + Express (native fetch proxy, in-memory cache)
- Audio: HTML5 Audio engine with preload, lazy stream resolution, error fallback

## 🚀 Quick start (works out of the box — no keys required)

```bash
cd soundwave
cp .env.example .env          # optional

# install everything
npm run install:all           # or: npm --prefix server install && npm --prefix client install

# run both (needs: npm install at root for concurrently)
npm install && npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:5000 (`/api/health`)

Or run separately:

```bash
npm run dev:server   # backend :5000
npm run dev:client   # frontend :5173 (proxies /api → :5000)
```

Production preview:

```bash
npm run build
npm --prefix client run preview
```

## 🌍 Deploy to a public URL (one service, zero config)

The server serves both the API and the built website, so any Node host works with one service.
Ready-made configs are included: `render.yaml`, `railway.toml`, `Dockerfile`.

**Option A — Render (free, ~5 min, recommended):**
1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New → Blueprint** → select your repo.
3. Render auto-detects `render.yaml` → click **Apply**. Done — you get a `https://soundwave.onrender.com` URL that works everywhere, no token needed.

**Option B — Railway:**
1. Push to GitHub → [railway.app](https://railway.app) → **New Project → Deploy from Repo**.
2. Railway uses `railway.toml` automatically → you get a public `*.up.railway.app` URL.

**Option C — Fly.io / VPS with Docker:**
```bash
docker build -t soundwave .
docker run -p 5000:5000 soundwave
# open http://your-server:5000
```

**Manual (any Node host):**
- Build command: `npm --prefix server install && npm --prefix client install && npm --prefix client run build`
- Start command: `npm --prefix server start` (or `node server/server.js`)
- No env vars required. Optional: `LASTFM_API_KEY`, `ITUNES_COUNTRY=IN`.

That's it — one URL serves the whole website + API (same-origin, no CORS issues).

## 🔑 Optional API keys (enrichment only)

| Key | Purpose | Where |
|-----|---------|-------|
| `LASTFM_API_KEY` | artist bios, tags, similar artists | last.fm/api/account/create |
| `SPOTIFY_CLIENT_ID/SECRET` | reserved for metadata/recommendations | developer.spotify.com |
| `AUDIODB_API_KEY` | reserved for hi-res images | theaudiodb.com |

Free, no-key integrations already active: **JioSaavn (saavn.dev)**, **Deezer**, **Lyrics.ovh**, **MusicBrainz-ready**.

To self-host JioSaavn: deploy [sumitkolhe/jiosaavn-api](https://github.com/sumitkolhe/jiosaavn-api) and set `JIOSAAVN_API_URL`.

## 📱 Install as app (PWA / APK-like)

1. Open the client URL in Chrome/Edge on Android (or desktop).
2. Menu → **Install app / Add to Home screen**.
3. For a real APK, wrap with Capacitor:

```bash
npm i -g @capacitor/cli
# in client/: npm i @capacitor/core @capacitor/android && npx cap init SoundWave com.soundwave.app
# npx cap add android && npm run build && npx cap sync && npx cap open android
```

## ⌨️ Shortcuts

Space play/pause · ←/→ seek 10s · ↑/↓ volume · M mute · N next · P previous

## 📁 Structure

```
soundwave/
├── server/server.js      # unified API aggregator (all routes)
├── client/src/
│   ├── services/musicApi.js
│   ├── store/useStore.js      # zustand + localStorage persist
│   ├── hooks/useAudioEngine.js
│   ├── components/ (Layout, Cards, Player)
│   ├── pages/ (Home, Search, Library, Detail, Settings)
│   └── App.jsx / main.jsx / index.css
└── README.md
```

## ⚠️ Notes

- Streams come from third-party public APIs; availability/quality varies by region and track.
- Deezer results are 30-second previews (labeled in UI); JioSaavn provides full tracks.
- Demo/educational project — respect artists and rights holders.
