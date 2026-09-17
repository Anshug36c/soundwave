# Deploying SoundWave on Hugging Face Spaces

Free: 2 vCPU / 16 GB RAM, no credit card. This is the recommended free host for
SoundWave because it runs the **whole app as one process** — the API and the
built client on the same origin — so there is no CORS to configure, no
`VITE_API_URL` to set, and Google sign-in works.

## Why it fits

- `Dockerfile` already builds and runs the single-process deploy (see below for
  what was verified).
- The server binds `0.0.0.0` (`server/server.js`), which Spaces requires.
- Measured footprint: **42 MB RSS at boot** with all three provider indexes
  loaded (djp 4,082 / djjohal 24,698 / mr-jatt 59,724). The default 160 MB audio
  cache fits easily in 16 GB, so — unlike a 512 MB PaaS — there is no need to
  lower `AUDIO_CACHE_MB`.
- Nothing needs a persistent disk: likes, playlists and history live in the
  browser (`localStorage`), and the caches are deliberately ephemeral.

## 1. Create the Space

1. <https://huggingface.co/new-space>
2. **Space name:** `soundwave` (your URL becomes `https://<user>-soundwave.hf.space`)
3. **License:** pick one (the repo is open source)
4. **SDK:** **Docker**
5. **Visibility:** **Public** — the free CPU tier requires a public Space
6. Create.

## 2. Push the code

A Space is just a git repo. From a clone of this repository:

```bash
git remote add hf https://huggingface.co/spaces/<user>/soundwave
git push hf main
```

It will ask for credentials: username is your HF username, password is a
**write** token from <https://huggingface.co/settings/tokens>.

The Space rebuilds on every push. Build logs are under **Settings → Build logs**.

## 3. Optional environment variables

None are required. Add these in **Settings → Variables and secrets** if you want
them:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Enables Google sign-in (see `AUTH_SETUP.md`) |
| `SESSION_SECRET` | Keeps sessions alive across restarts |
| `AUDIO_CACHE_MB` | Audio cache cap; the 160 MB default is fine here |
| `ITUNES_COUNTRY` | Already `IN` in the Dockerfile |

For `GOOGLE_CLIENT_ID`, add your Space URL to the OAuth client's **Authorized
JavaScript origins**: `https://<user>-soundwave.hf.space`.

## What was verified before writing this

Docker is unavailable in the dev sandbox, so the `Dockerfile` steps were run
directly instead of building the image:

1. `npm --prefix server install --omit=dev` — 72 packages
2. `npm --prefix client install` — 111 packages (dev deps, needed by Vite)
3. `npm --prefix client run build` — exit 0, 63 modules
4. `rm -rf client/node_modules client/src` — `client/dist` survives, which is
   all `server/server.js` reads (`path.join(__dirname, '../client/dist')`)
5. Boot with the Dockerfile's env (`PORT=5000 NODE_ENV=production`,
   `--openssl-legacy-provider`) — `/api/health` returns `ok: true`, `index.html`
   serves `200 text/html`, RSS 42 MB

## Things to watch

- **Sleep behaviour.** Community reports conflict on whether free Spaces go idle.
  If yours does, a free pinger (cron-job.org, UptimeRobot) hitting `/api/health`
  every 10 minutes keeps it warm — and that endpoint already reports uptime,
  cache stats and index sizes, so it doubles as monitoring.
- **Range requests.** Seeking uses HTTP Range (`Content-Range`/`206` in
  `server/server.js`). Test seeking on a track after your first deploy; if the
  proxy strips ranges, seeking breaks even though playback works.
- **Content policy.** Spaces are publicly listed. A music app that streams from
  third-party sites may attract moderation — see the legal notice in the main
  README. If that becomes a problem, set the Space to private and it stops being
  free.
- **Cold starts.** If the Space restarts, the indexes reload from providers
  before search is fast. `/api/health` shows `indexes` counts — wait for
  non-zero.
