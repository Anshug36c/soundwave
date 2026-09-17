# Google Sign-In Setup (one-time, ~5 minutes)

SoundWave ships with the sign-in code built in. To turn it on, create a free
OAuth Client ID in Google Cloud and paste it into Render. No billing needed.

## 1. Create the OAuth client

1. Go to <https://console.cloud.google.com/> and sign in with your Gmail.
2. Create a project (any name, e.g. `soundwave`) — or reuse an existing one.
3. Left menu → **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - App name `SoundWave`, your email for support + developer contact → Save.
   - Scopes: skip (defaults `openid email profile` are enough) → Save.
   - Test users: skip → Save. (No verification needed while you stay in Testing
     mode for personal use; add test users only if Google asks.)
4. Left menu → **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**, name `SoundWave web`.
   - **Authorized JavaScript origins** — add both:
     - `https://soundwave-nh48.onrender.com`
     - `http://localhost:5173` (local dev)
   - (Leave Authorized redirect URIs empty — we use the token flow, not redirects.)
   - Create → copy the **Client ID** (`….apps.googleusercontent.com`).

## 2. Enable it on Render

1. Render dashboard → your `soundwave` service → **Environment**.
2. Add `GOOGLE_CLIENT_ID` = the Client ID from step 1.
3. Add `SESSION_SECRET` = any long random string (keeps users logged in across
   restarts). Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Save — Render redeploys automatically. Done: the Settings page now shows a
   **Sign in with Google** button.

## 3. Verify

- `GET https://soundwave-nh48.onrender.com/api/auth/config` returns your client ID.
- Sign in → avatar appears top-right → sign out → guest library restored.

## Local dev

```bash
GOOGLE_CLIENT_ID=<your-id>.apps.googleusercontent.com \
SESSION_SECRET=dev-secret \
PORT=5090 node server/server.js
```

(Google requires the origin to match exactly — use `http://localhost:5173`
with `npm run dev`, not the preview proxy URL.)

## How it works

- The browser gets an ID token from Google (GIS button), the server verifies its
  RS256 signature against Google's public certs, then sets a signed HttpOnly
  session cookie (`sw_session`, 30 days, `SameSite=Lax`).
- Identity only: likes/playlists/history stay on-device, namespaced per Google
  account (`soundwave-acct:<sub>`), so family sharing one browser keeps separate
  libraries. Nothing is uploaded anywhere.
