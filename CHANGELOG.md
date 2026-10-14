# Changelog

## Unreleased

### Echo Music v1.4.2 / v1.4.3 sync
Recipes ported from [EchoMusicApp/Echo-Music](https://github.com/EchoMusicApp/Echo-Music)
(latest release v1.4.3, 2026-10-11). Upstream source files are named in the
README's "Ported from Echo Music" table.

- **Deterministic metadata cleaning** (`server/metadata.js`, port of `:metadata`,
  upstream #550). Five stages: unicode/entity sanitising, "Artist - Title" split,
  junk/version/featuring extraction, channel scrubbing (`- Topic`, `VEVO` →
  `Taylor Swift`, ` Records`), multi-artist split. One pipeline now feeds LRCLIB,
  KuGou, lyrics.ovh, YouTube → provider mirror resolution, mirror recovery and
  pasted-title search, replacing four partial per-call-site regexes. Band names
  with ampersands and conjunctions survive as searchable queries.
- **Local Taste Engine** (`client/src/services/taste.js`, upstream #542). Play
  time is now measured on device (buffered, flushed every 5s and on every
  handover) and skips are counted; seeds for the mix are ranked by
  `ln(1 + minutes) × 2 − skips × 3 + like + recency`, with a time-of-day
  multiplier, instead of "the last three songs that played".
- **Taste Mix + Forgotten Favourites** on Home. The mix refreshes itself every
  24h from a date seed rather than being rebuilt per visit; the new rail
  resurfaces genuinely-listened tracks that went quiet for a fortnight, ordered
  by a per-invocation seed (the v1.4.3 fix: one seed per refresh, never per
  render, so a list cannot reshuffle mid-read).
- **Equal-power crossfade** (upstream `EqualPowerCurve`): fades follow cos/sin so
  acoustic power stays constant through the handover; also used for sleep fades.
- **Adaptive pre-arm** (upstream `AdaptivePreArmManager`): measured standby
  preparation latency widens the re-verify window from 20s to 35s on slow
  networks and lets a slow standby run longer before it is abandoned.
- **Varispeed**: new player "Tape" button and Settings toggle set
  `preservesPitch = false`, so speed changes bend pitch tape-style. Off by
  default; the YouTube embed has no pitch control and stays plain-rate.
- **"Never recommend again"** (upstream `RecommendationExclusionDao`): the song
  action now excludes a track server-side too (`/api/for-you?exclude=`), so the
  rail refills the slot instead of returning a short list.
- **Fresher recommendations** (upstream #559): `/api/for-you` takes a per-refresh
  seed that varies the adventurous picks; the seed is part of the cache key.
- **Lyrics**: version-aware lookup (`Song (The Glitch Mob Remix)` tried before
  the bare title), KuGou keyword built from cleaned metadata, and inactive synced
  lines now blur by distance from the sung line.
- Tests: +22 server cases (ported from upstream `MetadataCleanerTest`) and +44
  client cases (from `LocalTasteScoringTest`, `EqualPowerCurveTest`,
  `AdaptivePreArmManagerTest`, `RecommendationRelationsTest`, plus store wiring:
  play-time accrual, skip counting, exclusion keys, the stats cap and the daily
  seed). 58 server, 57 client, all green — the store tests caught two real bugs
  on the way in (an uncapped `playStats` table, and exclusion keys that were
  never built because `disliked[id]` holds `true`, not a track).

### Before that
- Google sign-in (Gmail): official GIS button, server-verified ID tokens, signed
  HttpOnly session cookies, per-account on-device libraries, avatar menu, session
  restore on boot. Zero new dependencies. Needs `GOOGLE_CLIENT_ID` (see `AUTH_SETUP.md`).

## Roadmap waves A–E

### Search & discovery
- Exact-match-first ranking with stable order; typo suggestions that keep results
- Suggestion keyboard navigation (↑/↓/Enter/Escape) with combobox/listbox ARIA
- Local-playlist results inside search; provider-degradation banner

### Artists
- Discography pages: shuffle-all, add-all-to-queue, album rail on "all songs" view,
  incremental rendering (60 at a time)

### Playback
- Playback speed control (0.5×–2×, pitch-preserving, persisted)
- Queue drawer: reorder (persisted across reloads), play-next, add-many
- Elapsed/remaining time toggle; mobile-strip swipe for prev/next
- Synchronized (LRC) lyrics with auto-scrolling line highlight
- Auto audio quality from network speed; explicit low/medium/high override

### Library
- Liked songs: real "recently liked" sort + shuffle-all
- Playlists: shuffle, reorder, share, JSON export; library-wide JSON import
- Continue-listening card, Most Played (play counts), relative "played x ago" times

### Platform
- Service worker no longer auto-caches streams (explicit offline saves only)
- Offline banner; prefetch/warmup skipped while offline
- Route code-splitting (React.lazy), per-route document titles, OG/Twitter meta
- Privacy section with erase-all; local-only session diagnostics
- Removed unused `cors`/`dotenv` deps; zero `npm audit` vulnerabilities
- Vitest suite (11 tests) + GitHub Actions CI; README/CONTRIBUTING rewritten

### Reliability
- 429-aware provider backoff; same-name/different-recording dedupe guard (duration);
  richer cross-provider metadata merging; cache bust on total audio failure
- Concurrent identical GETs share one request; Escape closes player/queue/menus

## 2d9db33 — Stability pass
- Suggestion race guards (seq + AbortController + debounce cancel)
- Stall watchdog with recovery + skip-after-3; `online` event resume
- Suggest caching, rate-bucket pruning, audio payload caps
