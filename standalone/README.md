# SoundWave Lite — standalone, zero-server

A single HTML file that runs entirely on the device. No backend, no build step,
no account, nothing to host or keep alive. Open `index.html` and it works.

## Why this is possible without a server

Every API it uses sends `Access-Control-Allow-Origin: *`, which was verified
directly rather than assumed:

| API | Used for | ACAO |
| --- | --- | --- |
| `itunes.apple.com/search` | search + track metadata | `*` |
| `audio-ssl.itunes.apple.com` | playback (30 s previews) | media element — CORS not required |
| `is1-ssl.mzstatic.com` | artwork | `*` |
| `musicbrainz.org/ws/2` | artist info | `*` |
| `api.lyrics.ovh` | lyrics | `*` |

The providers the full SoundWave uses — DJPunjab, DJJohal, Mr-Jatt, PenduJatt,
JioSaavn — send **no** CORS header (`jiosaavn.com/api.php` returns 403 outright).
A browser cannot read their responses, which is precisely why `server/server.js`
exists. That constraint does not go away by packaging the app differently; a
WebView has the same restriction unless requests go through native networking.

## The trade-off

Apple only exposes **30-second previews**, so this plays previews, not full
songs. Full-length playback of the scraped providers requires a relay — either
the existing Node server, or a small Cloudflare Worker that adds CORS headers to
proxied requests. There is no client-side way around it: the browser will not
hand JavaScript the bytes.

Everything else works on-device: search, artwork, playback, seeking (the preview
host answers `206` with `Content-Range`, verified), auto-advance, and lock-screen
metadata via the Media Session API.

## Running it

Open the file directly:

```bash
xdg-open standalone/index.html      # Linux
open standalone/index.html          # macOS
start standalone\index.html         # Windows
```

Or serve it, or drop it on any static host — Cloudflare Pages, Netlify, GitHub
Pages. All are free and none of them run your code; they just serve the file.

## Turning it into an Android app

Open the hosted URL in Chrome → ⋮ → **Add to Home screen**. A PWA needs HTTPS
or `localhost` to install properly, so host it rather than opening the local
file if you want the app icon.

For a real `.apk`, wrap this file in Capacitor or a Trusted Web Activity. Note
that doing so buys you an installable icon and native share targets — it does
**not** lift the CORS restriction, because a WebView is still a browser. Getting
full tracks on-device would mean rewriting the provider layer to use Capacitor's
native HTTP plugin, which bypasses the WebView entirely.

## Status

Verified: JavaScript parses (`node --check`), every `getElementById` target
exists in the markup, and the search endpoint returns 40 playable results with
artwork for a Punjabi query.

Not verified: actual in-browser audio playback. Apple serves previews as
`content-type: audio/x-m4p`; that is normally plain AAC and browsers play it, but
this needs confirming on a real device.
