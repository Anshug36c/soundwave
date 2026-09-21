---
title: SoundWave
emoji: 🎵
colorFrom: purple
colorTo: pink
sdk: docker
app_port: 5000
pinned: false
short_description: Spotify-style Punjabi music streaming
---

# SoundWave 🎵

An open-source, Spotify-style music discovery and playback website. Search across
multiple Punjabi-music providers, play full tracks through a resilient streaming
pipeline (server cache + smart preloading), build playlists, and keep your
profile and library locally on the device.

**Live demo:** `https://soundwave-nh48.onrender.com/`

---

## 1. What Is This?

SoundWave is a website for finding and listening to music — mostly Punjabi songs
from sites like DJPunjab, DJJohal, and Mr-Jatt, plus JioSaavn metadata.

**In plain English:**

- **What is it?** A music player website with search, playlists, lyrics, and offline saves.
- **What problem does it solve?** Punjabi music is scattered across many sites with
  clunky pages and unreliable direct links. SoundWave puts search + fast playback +
  a modern player in one place.
- **What can users do?** Search songs/artists/albums, play full tracks, queue songs,
  like music, build playlists, follow artists, read (even synced) lyrics, tweak a
  10-band EQ with a live visualizer, download songs for offline, install it as an app.
- **Why was it built?** As a fast, local-first, open-source alternative to ad-heavy
  MP3 sites — no account required, and nothing you save ever leaves your device.
- **What makes it different?** A backend that aggregates several providers with
  mirror failover and CDN ranking, plus aggressive-but-polite preloading so skips
  feel instant.
- **Frontend-only or full-stack?** Both: a React frontend and a Node/Express backend.
  The backend does the provider scraping, audio proxying, and caching; the browser
  only ever talks to the backend (same-origin), never to provider sites directly.

---

## 2. Main Features

Everything below exists in the codebase today.

### Search
- Song / album / artist search across providers (`/api/search`, type tabs)
- Search suggestions as you type (`/api/suggest`, keyboard navigable)
- Typo-tolerant suggestions ("did you mean"-style), exact-match-first ranking
- Artist pages: top songs + complete cross-provider discography, follow/unfollow, hide
- Album pages with track lists; "Shuffle artist" and "add artist songs to queue"
- Home: search entry, Recently Played rail, and Recommended — a mix built from
  your last plays (seeded songs + top artists, deep cuts per artist) with a
  Familiar/Adventurous discovery slider

### Playback
- Play / pause / next / previous (previous restarts the track if > 3s in — like Spotify)
- Queue drawer: reorder, play-next, add-many, remove, clear; persists across reloads
- Seeking (slider, arrow keys ±10s, elapsed/remaining toggle), volume + mute
- Shuffle, repeat (off → all → one), playback speed (0.5×–2×, persisted)
- Sleep timer with fade-out, crossfade between tracks
- YouTube Music search (Echo InnerTube recipe): Songs/Albums/Artists/YouTube tabs, YT tracks play via closest-mirror resolve, KuGou as 3rd lyrics provider
- Hot-standby prefetch: next track staged before the current one ends
- Boot resume: refresh mid-song → player reopens paused at the same position
- MediaSession integration (OS media keys / lock-screen controls)
- Studio sound: WebAudio 10-band EQ + preamp + normalize + live visualizer

### Download & Cache
- Server-side audio cache (LRU, 12 full tracks, 1-hour TTL) with Range/206 support
- Request dedup: concurrent identical audio requests share one upstream fetch
- Fire-and-forget `/api/warm` endpoint pre-heats the cache ahead of playback
- Explicit offline saves: service worker caches the exact playback URL; works offline
- Next + second-next preloading with bandwidth staggering and offline/save-data guards

### User Experience
- Responsive layout, mobile bottom-nav + swipe-on-strip prev/next, installable PWA
- Dark / light themes (persisted), loading skeletons, buffering spinners, toasts
- Full keyboard control: `Space` play/pause, `N`/`P` next/prev, `←/→` seek,
  `↑/↓` volume, `M` mute, `S` shuffle, `R` repeat, `Q` queue, `⌘/Ctrl+K` palette
- Synced (LRC) lyrics via LRCLIB (Echo recipe: title cleanup + duration match), lyrics.ovh fallback, auto-scrolling highlight
- Offline banner + connectivity-aware fetching; "Erase all local data" one-tap reset
- Local profile, library, playlists, history, and offline saves (no account required)

---

## 3. How the Website Works — Simple Explanation

```text
User searches for a song
        ↓
Backend fans out to providers, merges + ranks results
        ↓
User presses Play → song joins the queue
        ↓
Player requests audio from the backend (/api/audio)
        ↓
Backend serves from cache, or fetches upstream (mirrors + failover)
        ↓
A short preview starts instantly; the full MP3 swaps in at the same spot
        ↓
Song plays; next songs are preloaded in the background
        ↓
Next song starts with minimal delay (often from warm cache)
```

**Each step in plain English:**

1. **Search** — your query goes to the backend, which asks several provider sites in
   parallel and merges the answers into one ranked list.
2. **Play** — tapping a song puts it (and its context) into the queue and tells the
   single audio element to load that song's backend stream URL.
3. **Fetch** — the backend checks its memory cache. On a miss it resolves the song's
   mirrors, picks the best bitrate for your quality setting, and proxies the bytes —
   failing over to the next mirror/bitrate if one stalls.
4. **Instant start** — while the full file loads, a short preview starts playing
   immediately; once enough of the full track is buffered, the player swaps to it at
   the same position. You never notice the handoff.
5. **Preload** — while you listen, the next track is staged and the one after is
   warmed on the server, so skipping feels instant.

---

## 4. How Playback Works

**Simple version:** pressing Play gives the browser's single audio element a
same-origin URL like `/api/audio?src=djp&id=298929&quality=high`. The backend
streams MP3 bytes for that URL (from cache when possible). The player handles
pause, seeking, volume, track changes, and recovery if a stream dies.

**Technical version:**

- **One audio element.** `useAudioEngine.js` owns a single `new Audio()` (`preload='auto'`).
  All play/pause decisions flow through `syncPlayback()` with a monotonically
  increasing token, so overlapping async `play()` promises can't fight each other.
- **File, URL, or stream?** A plain HTTP URL served by our backend with
  `Accept-Ranges: bytes`. The browser progressively downloads and seeks with
  `Range` requests (answered `206`). No Media Source Extensions, no Blobs for playback.
- **State lives in Zustand** (`useStore.js`): `queue[]`, `index`, `isPlaying`,
  `currentTime`, `duration`, `volume`, `muted`, `shuffle`, `repeat`, `playbackRate`,
  `quality`, `sleepTimerMin`, `buffering`. The persisted slice (`soundwave-store-v1`
  in localStorage) keeps queue/index/settings across reloads; `isPlaying` is
  deliberately *not* persisted — a refresh always reopens paused ("honest boot").
- **Track changes:** a `track.id` effect tears down preloads/standby, sets `el.src`
  directly to the full track, and re-arms preloading. Same-track quality changes
  reuse the element and keep the position.
- **Seek:** UI slider / arrow keys set `el.currentTime` (guarded — setting it before
  metadata throws, so all post-`src` seeks wait for `loadedmetadata`).
- **Volume/mute/speed:** direct element properties, persisted (volume, speed) or
  session-level (mute).
- **Next/previous:** index math in the store (`next()` honors shuffle; `prev()`
  restarts when `currentTime > 3`, else steps back with wraparound).
- **Track end:** `ended` advances according to repeat mode (`one` replays, `all`/queue
  continues, end-of-queue autoplays similar songs when Autoplay is on, else stops).
- **Failure:** `error` → one position-preserving stream reload per track; else toast
  + skip. A watchdog reloads streams stalled >12s (max 3 recoveries, then skips).
  After 4 errors in 15s the player stops with a toast instead of skip-looping forever.

---

## 5. How Downloading Works

"Downloading" here means the **backend fetching provider MP3 bytes to serve them**,
plus the **explicit offline-save** feature. There is no user-facing download manager
or progress bar — downloads are streaming proxies.

```text
Song requested (/api/audio)
        ↓
  Check server cache (key = source:id:quality:title|artist)
        ↓
   Already cached?
     ↙        ↘
   YES          NO → dedup: waiter joins inflight owner, or becomes owner
    ↓                           ↓
  Serve (200/206)        Resolve mirrors → try bitrates in quality order
                                    ↓
                          Proxy upstream bytes (20s TTFB + 25s rolling budgets)
                                    ↓
                          Complete 200s cached for next time → play
                                    ↓ (all mirrors dead?)
                          Cross-source recovery via title/artist → else 502
```

- **Trigger:** the audio element (main, standby, pool, or service worker) requesting
  a `/api/audio` URL, or a fire-and-forget `/api/warm` call.
- **Handler:** `server/server.js` (`/api/audio`, `/api/warm`, `/api/djp-audio`).
- **After bytes arrive:** they stream straight to the client; complete non-Range
  responses (>100KB, ≤20MB, exact length) are also stored in the memory cache.
- **Progress/cancel:** N/A (streaming). Client disconnect aborts the upstream read;
  partial data is never cached.
- **Duplicates:** an `audioInflight` map — the first full request per cache key owns
  the upstream fetch; concurrent identical requests wait, then serve its cache.
  Range requests never own (206s aren't cacheable) but may briefly wait.
- **Offline saves** are separate: the UI posts the *exact playback URL* to the
  service worker (`CACHE_AUDIO`), which stores the response in Cache Storage for
  offline playback. Without a service worker it falls back to a plain file download.

---

## 6. How the Cache Works

There are **four** caches — don't confuse them:

| Cache | Where | What | Limit | Survives refresh? |
|---|---|---|---|---|
| Audio cache | Server RAM (`audioCache`) | Complete MP3/FLAC bodies + bitrate | 12 tracks (LRU), 1h TTL, ≤20MB/file | Server-side: yes, until evicted/restart |
| Page cache | Server RAM (`pageCache`) | Scraped provider song pages (resolved URLs) | 6h TTL | Same as above |
| API cache | Server RAM (`getCache`) | Search/suggest/lyrics JSON | Per-endpoint TTLs | Same as above |
| Offline saves | Browser Cache Storage (service worker) | Exact playback URLs the user saved | Browser-managed quota | Yes — this is the real "offline" |

- **Song identity:** `audioKey()` = `source:id:quality:title|artist` (lowercased,
  stripped). Different quality tiers are different entries.
- **Hit:** served instantly with `X-Audio-Cache: HIT` (+ `X-Audio-Bitrate/Mirror`),
  full Range/206 support, honest `416` past EOF.
- **Incomplete/invalid:** partial responses are *never* written (length-checked), so a
  poisoned entry can't occur; Range (206) responses are never cached.
- **Eviction:** LRU within 12 entries + age TTL; total-failure responses also bust the
  related *page* cache so the next attempt re-scrapes fresh URLs.
- **Clearing:** restart the server (RAM caches) or remove the offline save /
  clear site data in the browser (Cache Storage).

---

## 7. Preloading / Prefetching

```text
Currently playing: Song A (index i)

Queue:  Song B (i+1)   Song C (i+2)   Song D (i+3...)

Player: Playing → A
        Staging → B  (dedicated Audio element → canplaythrough + server warm)
        Warming → C  (server-side /api/warm fetch, staggered after B settles)
        Waiting → D
```

- **Next (n1):** `armStandby()` creates a standby `Audio` element that preloads n1
  toward `canplaythrough` *and* fires `api.warm()` so the server cache is hot. A 30s
  timer guarantees n2 staging never stalls behind a slow n1. Metered-data mode
  (`saveData`) warms the server only, sparing the user's bytes.
- **Second-next (n2):** `preloadTrack()` warms n2 on the server once n1 settles —
  preloads never gang up on the bandwidth the playing track needs.
- **Similar songs:** 2.5s after a track loads, the first 4 similar tracks with
  stream URLs are warmed (lowest priority, cancelled if the track changed).
- **Warm dedup:** client-side 60s dedup per URL; server-side `warmInflight`
  (replies `202 warming` to dupes).
- **Queue changes / rapid skips:** every track load purges the pool and tears down
  standby first (`purgePreloads` + `teardownStandby`), then re-stages for the new
  neighbors — stale preloads can't waste sockets or clobber the new track.
- **Shuffle:** standby is skipped (next is random — staging would warm the wrong track).
- **Preload failure:** silent by design — a failed warm just means a cold start later;
  the main load path has its own full retry/failover.

---

## 8. Queue System

- **Entering:** tapping any song calls `playTracks(contextTracks, tappedIndex)` —
  the whole visible list becomes the queue with the tapped song current.
- **Current song:** `queue[index]`; `index = -1` means "nothing loaded".
- **Reorder/remove:** drawer controls (move up/down, remove, clear); persisted.
- **Next:** shuffle ? random different index : `(index+1) % length`.
- **Previous:** `currentTime > 3` ? restart to 0 : step back with wraparound.
- **Repeat:** `off → all → one → off`. `one` replays on `ended`; `all` wraps at the end; `off` at queue end triggers Autoplay (toggle in Settings).
- **Shuffle:** random next-index; also "Shuffle artist" (shuffled copy as queue).
- **With preloading:** n1/n2 derive from `index`; the re-stage effect reruns on
  `[index, n1id, n2id, quality, repeat, shuffle, queue.length]`.
- **Queue changes mid-load:** token/cancellation guards (`cancelled`, `playToken`,
  `dataset.trackId` checks, fade tokens) ensure stale async work can't touch the new
  track — verified by rapid-skip stress tests.

---

## 9. Search System

- **Start:** typing (debounced, cancellable) hits `/api/suggest`; submitting (or a
  `?q=` URL) hits `/api/search?q=&type=` with `type` ∈ songs/albums/artists/all.
- **Fan-out:** the server queries providers in parallel with per-provider timeouts
  and an outbound concurrency guard (48 global / 8 per host for metadata fetches).
- **Merge:** results are normalized into one `track`/`album`/`artist` shape,
  exact-match-first ranked, and tagged per provider (`DJP · FULL` etc.).
- **Duplicates:** same song on multiple providers becomes *mirrors* (`m=` params on
  the stream URL) for failover, not duplicate rows.
- **Failure:** dead providers are skipped (results flagged `partial` with a
  degradation banner + retry); a `degraded[]` list + per-CDN latency appear in
  `/api/health` and `/api/sources`.
- **To the UI:** JSON → React renders tabs + rows; local-playlist matches are folded
  in; clicking a row hands its list to the queue.

---

## 10. Artist Search

```text
User opens /artist/all/:name (or /artist/:source/:id)
          ↓
Backend gathers that artist's songs across providers (artist-songs)
          ↓
Top songs + per-provider counts + (async) album rail
          ↓
"Show complete discography" fans out deeper on demand
          ↓
Dedup by id, incremental render (60 rows at a time)
```

- `/artist/all/:name` is the cross-provider view (top songs, follow/hide, queue-all).
- Partial results show "Some providers timed out — retry", which re-runs the fetch.
- Artist images/bios are enriched where available; everything degrades to initials.

---

## 11. Providers / External Services

All provider traffic happens **server-side**; the browser never contacts providers.

| Provider | Purpose | Used by | Input → Output | On failure | Config |
|---|---|---|---|---|---|
| **DJPunjab** (`djp`) | Song/album pages + MP3s; on-disk index | Search, audio, albums | query / numeric id → tracks, `mp3s{320,128,48…}`, covers | Next mirror; page-cache bust on total fail | `DJP_BASE_URL` (default `https://djpunjab.is`) |
| **DJJohal** (`dj`) | Songs + MP3s; on-disk index | Search, audio | slug/id → tracks, MP3s, covers | Same as above | None (built-in) |
| **Mr-Jatt** (`mrj`) | Songs + MP3s; on-disk index | Search, audio | id → tracks, MP3s, hi-res covers | Same as above | None (built-in) |
| **PenduJatt** | Extra mirror | Audio failover | id → MP3 | Skipped silently | None |
| **JioSaavn** (`saavn`, via Rhythmax API) | Metadata + encrypted stream URLs | Search, audio | query/token → tracks, DES-encrypted URLs (decrypted with legacy OpenSSL + `_96→_160→_320` upgrade) | Skip / next mirror | None (built-in `rthmx.vercel.app`) |
| **lyrics.ovh** | Lyrics text | `/api/lyrics` | artist+title → lyrics (plain or LRC) | "Lyrics not available" | None |

Why several music providers? No single source has everything, and direct links rot.
Mirrors + fastest-CDN ranking (`cdnScore`, visible in `/api/sources`) keep playback
working when any one source is slow or down.

> `SPOTIFY_*`, `LASTFM_*`, `AUDIODB_*`, `JIOSAAVN_API_URL`, `ITUNES_COUNTRY` appear in
> `.env.example`/deploy files but are **not read by the code** — reserved for future
> enrichment, safe to ignore.

---

## 12. Project Architecture

```text
                         ┌─────────────────────┐
                         │       Browser       │
                         │  React + Zustand UI │
                         └──────────┬──────────┘
                                    │  same-origin /api only
                    ┌───────────────┼────────────────┐
                    ↓               ↓                ↓
             Search pages     useAudioEngine    Library/Settings
              (Search.jsx)   (1 Audio element)  (localStorage)
                    │               │  queue, preload, resume
                    ↓               ↓
         ┌──────────────────────────────────────┐
         │        Node/Express backend          │
         │  /api/search /audio /warm /lyrics…   │
         │  RAM caches │ inflight dedup │ CDN   │
         │  ranking │ mirror failover │ indexes│
         └──────┬──────────────┬────────┬───────┘
                ↓              ↓        ↓
          DJP / DJJ / MRJ   Saavn    lyrics.ovh
          provider sites   (Rhythmax)
```

- **Browser:** renders everything, owns playback state, preloads via extra `Audio`
  elements and `/api/warm`; persists library/settings in localStorage.
- **Backend:** the only thing that touches providers; proxies audio with caching,
  dedup, failover, and Range support; serves the built frontend + PWA shell.
- **Service worker:** precaches the app shell; stores explicitly saved songs for
  offline (with Range-206 support); relays cache status to the page.
- **No database.** Server state is in-memory (caches/indexes); user state is on-device.

---

## 13. Folder & File Structure

```text
soundwave/
├── client/                  # React frontend (Vite)
│   ├── public/
│   │   ├── sw.js            # service worker (shell precache + offline audio)
│   │   ├── manifest.json    # PWA manifest + icons/
│   │   └── favicon.svg
│   └── src/
│       ├── main.jsx         # React entry, router mount
│       ├── App.jsx          # routes, offline banner
│       ├── index.css        # Tailwind + theme
│       ├── pages/           # Home, Search, Library, Detail (artist/album), Settings
│       ├── components/      # Player, Cards, Layout, Equalizer, Visualizer,
│       │                    # CommandPalette, SimilarSongs, Icons
│       ├── hooks/
│       │   └── useAudioEngine.js  # THE playback engine (element, queue fx, preload)
│       ├── store/
│       │   └── useStore.js  # Zustand: queue, library, settings, persistence
│       ├── services/
│       │   └── musicApi.js  # API client, streamFor(), warm(), diagnostics
│       ├── audio/
│       │   └── studio.js    # WebAudio graph: EQ, preamp, normalize, analyser
│       └── utils.test.js    # vitest unit tests
├── server/
│   ├── server.js            # Express app: ALL /api/* routes, caches, proxying
│   ├── auth.js              # Google ID-token verify + signed cookie sessions
│   └── test/auth.test.js    # node:test unit tests
├── .github/workflows/ci.yml # server check+test+audit, client test+build+audit
├── render.yaml / railway.toml / Dockerfile  # deploy targets
├── AUTH_SETUP.md / CHANGELOG.md / CONTRIBUTING.md
├── .env.example
└── README.md (this file)
```

| File | Responsibility |
|---|---|
| `client/src/hooks/useAudioEngine.js` | Playback: element control, full-track loading, seek/volume/keys, preloading, resume, watchdog, MediaSession |
| `client/src/store/useStore.js` | Queue + library + settings state, actions, localStorage persistence, offline-save + download logic |
| `client/src/services/musicApi.js` | Backend client, `streamFor(track, quality)` URL builder, warm dedup, quality tiers, diagnostics counters |
| `client/src/components/Player.jsx` | Player bar, full player, queue drawer, lyrics/EQ/details tabs, sleep/speed/menus |
| `client/src/audio/studio.js` | WebAudio routing: 10-band EQ, preamp, loudness normalize, visualizer analyser |
| `client/public/sw.js` | PWA shell cache + exact-URL offline audio cache with Range support |
| `server/server.js` | Search fan-out, `/api/audio` proxy+cache+dedup+failover, warm, lyrics, for-you recommendations, indexes, health |
| `server/auth.js` | Google sign-in verify + cookie sessions (optional; guest works without) |

---

## 14. Which File Does What?

```text
Want to change the player UI?        → client/src/components/Player.jsx
Want to change playback behavior?    → client/src/hooks/useAudioEngine.js
Want to change queue behavior?       → client/src/store/useStore.js (actions) +
                                       useAudioEngine.js (load/staging effects)
Want to change downloading/proxying? → server/server.js (/api/audio, tryStream)
Want to change caching?              → server/server.js (audioCache/pageCache) or
                                       client/public/sw.js (offline saves)
Want to change search?               → server/server.js (/api/search, providers) +
                                       client/src/pages/Search.jsx (UI)
Want to add a provider?              → server/server.js (fetch + normalize + mirrors)
Want to change preloading?           → useAudioEngine.js (armStandby/preloadTrack/
                                       refreshUpcoming) + musicApi.warm
Want to change quality tiers?        → server QUALITY_ORDER + client quality setting
Want to change the EQ/studio sound?  → client/src/audio/studio.js + Equalizer.jsx
Want to change auth?                 → server/auth.js + GoogleLogin.jsx + AUTH_SETUP.md
Want to change styling/theme?        → client/src/index.css + Settings.jsx
```

---

## 15. Technology Stack

### Frontend
- **React 18** — UI rendering.
- **JavaScript (JSX, no TypeScript)** — app language.
- **React Router 7** — page routing (`/`, `/search`, `/library`, `/liked`, `/playlist/:id`, `/artist…`, `/album…`, `/settings`).
- **Zustand 5** — global state + localStorage persistence.
- **Tailwind CSS 4** — styling (via the Vite plugin).

### Backend
- **Node.js 20 + Express 4** — HTTP server and all `/api/*` routes.
- **compression** — gzip for API/asset responses.
- **No database** — in-memory caches + on-disk provider indexes.

### Audio
- **HTMLAudioElement** — the one and only player (progressive HTTP + Range seeks).
- **WebAudio API** — optional Studio graph (EQ/preamp/normalize/analyser).
- **Server proxy** — audio bytes always come from our backend, never hotlinked.

### Storage
- **Server RAM Maps** — audio/page/API caches (not persistent).
- **localStorage** — `soundwave-store-v1` (library+queue+settings), `soundwave-acct-*`
  (per-account), `soundwave-diag-v1`, `soundwave-debug` flag.
- **sessionStorage** — `soundwave-pos-v1` (resume position for the open tab).
- **Cache Storage** — service-worker offline songs + app shell.

### Development
- **npm** (lockfiles in both packages) — installs; `npm ci` in CI/deploys.
- **Vite 6** — client dev server + production build.
- **vitest** — client unit tests; **`node:test`** — server unit tests.
- **GitHub Actions** — syntax check, tests, build, `npm audit` on every push/PR.

---

## 16. Installation

Prerequisites: **Node.js 20** (18+ works; 20 is what CI/deploys use) and npm.

```bash
git clone https://github.com/Anshug36c/soundwave.git
cd soundwave

# server (production deps are enough to run)
cd server && npm ci --omit=dev && cd ..

# client (needs dev deps to build)
cd client && npm ci --include=dev && cd ..
```

> The `--openssl-legacy-provider` flag (already in the server scripts) is required:
> JioSaavn stream URLs use legacy DES decryption that OpenSSL 3 disables by default.

---

## 17. Configuration

Only these variables are **actually read by the code**:

| Variable | Where | Required? | What happens if missing |
|---|---|---|---|
| `PORT` | server | No (default `5000`) | Server listens on 5000 |
| `DJP_BASE_URL` | server | No (default `https://djpunjab.is`) | Uses the default DJP mirror |
| `GOOGLE_CLIENT_ID` | server | No — needed only for Google sign-in | Sign-in button hidden/disabled; guest mode unaffected (see `AUTH_SETUP.md`) |
| `SESSION_SECRET` | server | No, but recommended with Google login | Sessions die on restart (server logs a warning) |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` | server | No (working defaults ship in code) | Preview starter may fail → player falls back to full-only |
| `VITE_API_URL` | client build-time | No (defaults to same-origin `/api`) | Same-origin API (correct for standard deploys) |

Set server vars in your shell, a `server/.env`-style file (loaded how you run it —
plain `PORT=5090 node …` works), or your host's dashboard. Never commit real secrets.

---

## 18. Running the Project

### Development (two terminals)

```bash
# terminal 1 — backend (from repo root)
PORT=5090 npm --prefix server run dev
# serves API on http://localhost:5090/api/*

# terminal 2 — frontend
npm --prefix client run dev
# Vite on http://localhost:5173 (proxies /api to the server — check vite.config)
```

> Note: the root `npm run dev` script uses `concurrently` — install root
> devDependencies first if you want the one-command version.

### Production (single process)

```bash
npm --prefix client run build   # → client/dist (gitignored, built on deploy)
PORT=5000 npm --prefix server start
# app + API on http://localhost:5000
```

The server serves `../client/dist` and falls back to `index.html` for SPA routes.

---

## 19. Building for Production

- **Command:** `npm --prefix client run build` (Vite → `client/dist/`).
- **Output:** static files; the Express server serves them — no separate static host needed.
- **Env:** no build-time vars required (`VITE_API_URL` only if the API lives elsewhere).
- **Special requirements:** Node 20; server must start with `--openssl-legacy-provider`
  (already in `npm start`); provider sites must be reachable from the host (some hosts'
  egress IPs get rate-limited — see Troubleshooting).

---

## 20. Deployment

Three supported targets (all build the client, then run the single Node process):

- **Render (easiest):** `render.yaml` blueprint — New → Blueprint → select repo.
  Sets `NODE_VERSION=20`, health check `/api/health`; add `GOOGLE_CLIENT_ID` /
  `SESSION_SECRET` in the dashboard if you want sign-in.
- **Railway:** `railway.toml` (Nixpacks) with equivalent build/start commands.
- **Docker / Fly / VPS:** `Dockerfile` (node:20-alpine, exposes 5000).
- **Your own device:** `docker compose up -d --build` — free, no card, no egress
  bill, no free-tier sleep. Reach it from anywhere with a Cloudflare Tunnel
  (no port forwarding, works behind CGNAT). See `docs/SELF_HOSTING.md`.
- **Your Android phone, as an APK:** the runtime is bundled *inside* the app —
  Termux's real `node` binary plus its full library closure, ~22 MB packed. It
  runs the unmodified backend on-device and serves the app to a WebView over
  loopback. No server, no hosting, no Termux install. Built by GitHub Actions and
  attached as a downloadable artifact. See `docs/APK.md`.
- **Your Android phone, under Termux:** the same backend running in the Termux
  app, because the server has zero native dependencies — 4.3 MB of disk, ~41 MB
  of RAM. More setup than the APK, but it is the path that is known to run on a
  phone today. See `docs/TERMUX.md`.
- **No backend at all:** `standalone/index.html` is a single self-contained file
  that runs entirely in the browser using CORS-enabled APIs. Plays 30-second
  previews only, because the scraped providers send no CORS header.

No external database, Redis, or object storage is ever needed.

### Cloudflare Pages (static front-end)

Cloudflare Pages serves static files only — it cannot run `server/server.js`
(an Express process with in-memory caches and 120 s upstream fetches). Pages
Functions are no substitute: the Workers free plan allows **10 ms of CPU per
request** and 50 subrequests, while `/api/search` fans out to several providers
and walks in-memory indexes of 85 k tracks.

Set these in **Pages → your project → Settings → Build**:

| Setting | Value |
| --- | --- |
| Framework preset | **Vite** |
| Build command | `npm run build` |
| Build output directory | `client/dist` |

The output directory is the one thing you must change — it defaults to `dist`
at the repo root, which does not exist here.

`npm run build` is deliberately self-sufficient: it installs `client/` deps if
`client/node_modules/.bin/vite` is missing, then builds. That is required
because Pages picks its own package manager (it detected `bun` here) and runs
install **only at the repo root**, where the sole dependency is `concurrently`
— so `client/node_modules` is never created and `vite build` dies with
`sh: 1: vite: not found`.

Two files ship from `client/public/` into the output dir and are read by Pages:

- `_redirects` — SPA fallback (`/* /index.html 200`). Without it, a refresh or
  shared link to any of the 9 client routes 404s, because only `index.html`
  exists on disk.
- `_headers` — year-long immutable caching for hashed `/assets/*`, and
  `no-cache` for `sw.js` / `manifest.json` / `index.html` so a deploy actually
  reaches returning users instead of being masked by a stale service worker.

Then point the client at a backend and allow that origin on the server:

| Where | Var | Value |
| --- | --- | --- |
| Pages → Settings → Environment | `VITE_API_URL` | `https://your-api-host/api` |
| API host | `FRONTEND_URL` | `https://your-project.pages.dev` |

`VITE_API_URL` is read at **build time** (`client/src/services/musicApi.js`:
`import.meta.env.VITE_API_URL || '/api'`), so redeploy after setting it.

`FRONTEND_URL` drives the server's CORS allowlist (`server/server.js`); comma-
separate several origins. Unset, the server allows any origin for its public
read-only endpoints; set, only listed origins get `Access-Control-Allow-Origin`.
Both sides are required — without the server side every `/api` fetch is blocked
by the browser, **and** playback is silently muted: `createMediaElementSource`
on a tainted cross-origin `<audio>` element routes silence, so the player would
appear to play while the EQ and visualizer output nothing. The client sets
`crossOrigin="anonymous"` on its audio elements (`useAudioEngine.js`) and the
server answers `ACAO`, which together keep the WebAudio graph clean.

**Google sign-in will not work on a split deployment.** The session is an
HttpOnly `SameSite=Lax` cookie, which browsers do not send on cross-site
requests, and the client fetches without `credentials: 'include'`. Cross-site
auth would need `SameSite=None; Secure` plus credentialed CORS — and
`SameSite=None` is rejected on plain-`http` `localhost`, breaking local dev.
For sign-in, run the single-process deploy on one host instead.

### Vercel (static front-end)

Same constraints as Pages. `vercel.json` pins the install/build/output
commands, so no dashboard setup is needed — but `VITE_API_URL` and
`FRONTEND_URL` still apply exactly as above.

### Why `vercel.json` exists

The repo is a monorepo of *sibling* projects (`client/`, `server/`), each with its
own `package.json` + lockfile, and the root has no `workspaces` field. A bare
`npm install` / `bun install` at the root therefore installs only the root's one
dev dependency (`concurrently`) and never touches `client/node_modules` — after
which `vite build` dies with `sh: 1: vite: not found`. `vercel.json` overrides the
install step to `npm --prefix client ci --include=dev`, matching what Render,
Railway and the Dockerfile already do.

---

## 21. Error Handling

| Layer | Behavior | What the user sees | What to check |
|---|---|---|---|
| Search provider | Per-provider timeouts; failures skipped, `partial` flag | Results + "some providers timed out — retry" | `/api/sources`, server log, provider reachability |
| Audio mirror | Bitrate→mirror nested loops, TTFB/rolling budgets | Nothing (silent failover) | `X-Audio-*` headers, `/api/health` `audio{}` |
| Total audio fail | Cross-source recovery via title/artist, then page-cache bust + `502` | Toast → auto-skip; after 4 fails/15s, stops with toast | Upstream blocks, `t`/`ar` params present |
| Preview fail | Falls back to full-only | Nothing | Tidal credentials/route |
| Stall | 12s no-progress watchdog → `el.load()` ×3 → skip | "Connection stalled — recovering" toast | Network, `/api/health` `outbound` |
| Lyrics | Provider miss → null | "Lyrics not available" | Artist/title spelling |
| API crash safety | Route-level try/catch → JSON errors, never hangs | Toast / error panel | Server log, `node --check` after edits |
| Client runtime | Listeners guarded; debug via `localStorage soundwave-debug=1` (`[audio]` trace) | Toasts, skeletons | DevTools console, Settings → Diagnostics |

---

## 22. Common Problems & Fixes

### Song won't play / immediate skip
- Upstream mirrors dead or egress IP blocked → check `curl` of the `/api/audio` URL
  (`502` + `X-Audio-*` absent = total fail); retry later or from another network.
- Corrupt resolved URL → server auto-busts page cache on total failure; retry once.

### Playback stalls mid-song
- Dead socket → watchdog recovers automatically (toast confirms). If it loops, the
  upstream is throttling — try another quality tier (different CDN/bitrate).

### First song slow, later songs fast
- Expected: cold server cache + page scrapes on first play; subsequent plays hit
  warm caches and preloaded neighbors.

### Search returns nothing / partial
- Provider timeouts (cold, slow networks) → use the retry button; check `/api/sources`
  for `degraded[]`. Never a client bug if other types return results.

### Offline song won't play offline
- Only songs saved via the Offline button (exact playback URL incl. quality) work
  offline. Changing quality afterwards needs a re-save. Check DevTools → Application →
  Cache Storage.

### Google sign-in missing
- Set `GOOGLE_CLIENT_ID` (+ `SESSION_SECRET`) and follow `AUTH_SETUP.md`. Guest mode
  is fully functional without it.

### Build fails
- Client: `cd client && npm ci --include=dev && npm run build` (Node 20).
- Server syntax: `cd server && node --check server.js`.
- Saavn decryption is pure JS (`server/des.js`), so no `--openssl-legacy-provider`
  is needed and the server starts anywhere Node runs.

---

## 23. Development Guide

- **UI:** `client/src/pages/*`, `client/src/components/*`; theme tokens in `index.css`.
- **Playback/queue/preload/resume:** `hooks/useAudioEngine.js` (element + effects),
  `store/useStore.js` (state + actions). Keep the "single owner" rule: only
  `syncPlayback()` calls `play()/pause()`; only the load effect sets `src` per track.
- **Download/cache (server):** `server/server.js` — `/api/audio` + `audioCache` /
  `audioInflight`; offline: `client/public/sw.js` + `toggleDownload`.
- **Providers:** `server/server.js` (fetch → normalize → `mp3s{}` map → mirrors).
- **Config:** env vars (server), `useStore` defaults + `partialize` (client persisted slice).
- **Test changes:** `npm test` (client) + `npm run build`; `node --check server.js` +
  `npm test` (server); then click through: search → play → skip ×5 → quality switch →
  reload-resume, watching DevTools for errors. See `CONTRIBUTING.md`.

---

## 24. Adding a New Provider

1. **Fetch:** add a `fetchXxx*` function in `server/server.js` following the existing
   provider functions (query → HTML/JSON → items). Reuse `fetchText`/`fetchJson`
   (retry + outbound guard) and `pageCache` (6h) for scraped pages.
2. **Normalize:** return the shared shape —
   `{ id: '<src>:…', source, sourceId, type:'track', title, artist:{name}, album,
   duration, image, streamUrl, previewUrl, codec, quality, plays }`.
   Audio-capable providers must resolve `r.mp3s = { '320': url|[urls], '128': …, … }`
   (+ `r.page` for cache-busting, `r.type` for content-type) via `resolveMirror(source, sid)`.
3. **Register:** wire the source key into search fan-out, `/api/sources`, and the
   mirror lists (`mirrors` / `m=` params); add any base URL as an env var with default.
4. **Errors:** throw on failure (callers skip failed providers); never return half-
   normalized items; honor `refererFor()` if the host needs a Referer.
5. **Test:** `curl /api/search?q=<known hit>`, `curl -I '<streamUrl>'`, then full
   playback + skip + offline-save in the browser; confirm `/api/health` stays clean.

---

## 25. Adding / Modifying Playback Features

- **Play/pause:** only via `syncPlayback()` (token-guarded). Never call `el.play()`
  ad-hoc — stale promises will flip UI state.
- **Queue:** mutate through store actions (`playTracks/next/prev/addToQueue/…`) so
  persistence + history + preload effects stay consistent.
- **Preloading:** extend `refreshUpcoming()` keys + `armStandby`/`preloadTrack`;
  always purge first; respect `navigator.onLine` and `saveData`.
- **Downloading/cache:** server owns bytes; client owns URLs. Offline must cache the
  *exact* playback URL (`streamFor(track, quality)`), never the raw `streamUrl`.
- **Seeking:** never set `currentTime` synchronously after assigning `src`
  (readyState is stale) — always `loadedmetadata` + track-id guard.
- **Recovery:** keep the layers independent — mirror failover (server) → element
  retry (client) → skip (store) → stop (guard). Test with throttled/blocked upstreams.

---

## 26. Data Flow

**Search**
```text
User → Search UI → /api/search → providers (parallel) → normalize/merge/rank → UI rows
                    ↘ /api/suggest (debounced) → suggestion dropdown
```

**Playback**
```text
User → SongRow → playTracks(queue, index) → useAudioEngine → el.src = /api/audio…
→ server cache/proxy (or preview race → full swap) → timeupdate → store → UI
```

**Queue / preload**
```text
queue[index] → current → n1 standby (element + warm) → n2 warm → similar warm
     ↘ skip/reorder → purge + teardown → re-stage for new neighbors
```

---

## 27. Performance

Actually implemented: server audio LRU + page/API caches; inflight request dedup;
`/api/warm` pre-heating; hot-standby + staggered n2/similar preloading; fastest-CDN
ranking with latency memory; outbound concurrency caps; debounced + cancelled search
input; incremental artist rendering (60 rows); React route-level code splitting
(`Detail-*` chunk); `compression` gzip; tiny client footprint (React/Router/Zustand/
Tailwind only). Deliberately absent: virtualized lists, image CDN/resizing, persistent
server cache (RAM-only by design), offline *streaming* of non-saved songs.

---

## 28. Privacy & Security

- **On-device:** library, queue, settings, history, per-account data (localStorage);
  resume token (sessionStorage); offline songs (Cache Storage). "Erase all local
  data" wipes it. Diagnostics never leave the device.
- **Sent to backend:** search queries, audio/resolve requests, (optional) Google ID
  token at sign-in. The backend forwards queries/titles to provider sites to fetch
  results — provider traffic is server-side only.
- **Secrets:** `SESSION_SECRET` (HMAC cookie signing) and Google/Tidal credentials
  live in env vars, never in the repo or client bundle. Don't put secrets in
  `VITE_*` (those ship to browsers).
- **Limitations:** no E2E encryption of saved data; server logs may contain query
  strings; anyone with your device (or your Render logs) can see what you played.

---

## 29. Legal / Content Source Notice

SoundWave is open source and does not own, host, or license the music it finds —
it queries third-party provider sites and proxies their publicly served files for
playback. Those providers have their own terms of service. If you deploy or use
this project, you are responsible for complying with applicable laws and provider
terms in your jurisdiction. Nothing here is legal advice.

---

## 30. Testing

| What | Command | Where |
|---|---|---|
| Client unit tests (11, vitest: formatters, shuffle, quality, stream URLs) | `npm test` | `client/` |
| Server unit tests (18, node:test: Google-token verify, sessions, cookies) | `npm test` | `server/` |
| Server syntax check | `node --check server.js` | `server/` |
| Client production build | `npm run build` | `client/` |
| Dependency audit | `npm audit --audit-level=high` | both (CI) |

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR. There are
**no end-to-end tests in the repo**; pre-push verification is manual (search → play →
skip → quality switch → reload-resume, zero console errors). No lint/typecheck setup.

---

## 31. Contributing

1. Fork → branch from `main` → keep PRs focused (one feature/fix).
2. Follow `CONTRIBUTING.md`: root-cause fixes, no regressions (tests + build +
   `node --check`), local-first, Tidal stays preview-only, tiny client footprint.
3. Commits: short imperative subject + what/why body.
4. PR must include: what changed, how tested (commands + results), UI screenshots.
5. CI must pass (server check+test+audit, client test+build+audit).

---

## 32. Code Style

Per `CONTRIBUTING.md` + the codebase: plain functions + small modules; errors handled
where they happen (route try/catch, UI toasts, `catch → fallback` chains — no silent
swallows of load-bearing failures); no new client dependencies without strong reason;
imperative commit subjects. No formatter/linter config ships — match surrounding style.

---

## 33. Potential Future Improvements

*Ideas only — none of these exist yet.*

- Persistent server cache (disk/Redis) so deploys don't cold-start audio
- More providers + richer metadata enrichment (the `.env.example` keys are reserved)
- E2E test suite in-repo (Playwright) + lint/typecheck setup
- Virtualized long lists, image optimization, offline auto-caching of queue
- Stronger playback recovery (adaptive bitrate fallback mid-song)
- An actual open-source license file (see below)

---

## 34. Open Source License

**No license file was found in the repository.** Until the owner adds one (e.g.
`LICENSE` with MIT/Apache-2.0/GPL text), the code is *not* legally open-source —
all rights remain with the author by default and others may only view it. If you're
the owner: add a license to make the "open source" label real.

---

## 35. Credits

- **Providers/CDNs:** DJPunjab, DJJohal, Mr-Jatt, JioSaavn data via the Rhythmax API,
  Tidal previews, lyrics via lyrics.ovh
- **Libraries:** React, React Router, Zustand, Tailwind CSS, Vite, Vitest, Express
- **Auth:** Google Identity Services (optional sign-in)
- **Hosting:** Render (live demo), Railway + Docker supported

---

## 36. FAQ

**Is this open source?** The code is public on GitHub, but no license file exists yet —
see §34.

**How does playback work?** One audio element streams same-origin `/api/audio` URLs;
the backend serves cache or proxies provider MP3s with mirror failover. §4.

**Does the website store downloaded audio?** The server keeps the last 12 complete
tracks in RAM (1h); browsers keep only explicitly saved offline songs. §6.

**Where is audio cached?** Server RAM + browser Cache Storage (offline saves). §6.

**Why does the first song take longer?** Cold caches + first page scrape; later plays
reuse warm caches and preloaded neighbors.

**How does preloading work?** Next track staged to `canplaythrough`, second-next
server-warmed, similar tracks warmed last — all purged/re-staged on every change. §7.

**Can I add another provider?** Yes — fetch + normalize + register + test. §24.

**Where do I change the player / cache / downloading?** §14 has the file map.

**Do I need an account?** No. Guest mode is complete; Google sign-in only switches
between on-device libraries.

---

## 37. Beginner Explanation

> If you're completely new to the project, think of it like this…

```text
1.  You type a song name; the server asks several music sites at once.
2.  It merges the answers into one clean list and shows it to you.
3.  You press Play; the song (and its list) enters the queue.
4.  The player asks the server for that song's audio URL.
5.  The server checks its memory: served instantly if cached.
6.  If not, it fetches the MP3 from the fastest working mirror.
7.  A short preview starts at once; the full song swaps in silently.
8.  The queue tracks what's playing; the bar shows progress.
9.  Meanwhile, the next song is staged and the one after is warmed.
10. You skip → the staged song starts almost instantly.
11. If a stream dies, the player retries, then skips, then stops safely.
12. Likes/playlists/settings live only in your browser (or per Google account).
13. Saved-for-offline songs play even without internet.
14. Refresh mid-song → the player reopens, paused, at the same spot.
```

---

*Stack: React 18 + Vite + Tailwind + Zustand · Node 20 + Express · No database ·
PWA with offline saves · Optional Google sign-in.*
