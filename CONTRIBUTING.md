# Contributing to SoundWave

## Setup

```bash
git clone https://github.com/Anshug36c/soundwave.git
cd soundwave
cd server && npm ci --omit=dev
cd ../client && npm ci --include=dev
```

Run `server` with `PORT=5090 node --openssl-legacy-provider server.js` and
`client` with `npm run dev`.

## Conventions

- **Root-cause fixes, not symptom patches.** If a bug recurs, the first fix was wrong.
- **No regressions:** run `npm test` + `npm run build` (client) and
  `node --check server.js` (server) before pushing.
- **Local-first:** no accounts, no tracking, no uploads. Diagnostics stay on-device.
- **FLAC/Tidal is preview-only** (~30s starter). Song info, covers, and full
  playback come from the Punjabi providers.
- Keep the client dependency footprint tiny (React, Router, Zustand, Tailwind).
- Commits: short imperative subject + what/why in the body.

## Pull requests

1. Fork, branch from `main`, keep PRs focused (one feature/fix each).
2. Include: what changed, how you tested it (commands + results), screenshots for UI.
3. CI must pass: server syntax check + audit, client tests + build + audit.

## Reporting bugs

Use the bug template and paste your Settings → Diagnostics counters.
