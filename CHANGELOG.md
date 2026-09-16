# Changelog

## Unreleased (roadmap waves A–E)

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
