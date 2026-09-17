# Running SoundWave on your Android phone (Termux)

The whole app — backend and front end — running on the phone itself. No server
anywhere, no internet needed except to fetch the music.

This works because the server has **zero native dependencies** (0 `.node`
binaries, 0 `binding.gyp`), no absolute paths, and no OS assumptions. It needs
**4.3 MB of disk** and about **41 MB of RAM**. Verified, not estimated.

---

## 1. Install Termux

Get it from **F-Droid**: <https://f-droid.org/packages/com.termux/>

Do **not** use the Play Store version — that build is deprecated, years out of
date, and its package repository no longer works.

## 2. Install Node.js and git

Open Termux and run:

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs-lts git
node -v        # must be 18 or newer
```

`nodejs-lts` gives you Node 18+, which is what `server/package.json` requires.
It also supports the `--openssl-legacy-provider` flag that JioSaavn decryption
needs.

## 3. Get the app

```bash
git clone https://github.com/Anshug36c/soundwave.git
cd soundwave
```

## 4. Install and build

```bash
npm run install:all
npm run build
```

Takes a couple of minutes on a phone. This compiles the React app into
`client/dist`, which the server then serves.

## 5. Run it

```bash
AUDIO_CACHE_MB=32 PORT=5000 npm run start
```

`AUDIO_CACHE_MB=32` matters. The default is 160 MB, which combined with the
provider indexes would push the process toward 250 MB — enough for Android to
kill it under memory pressure. 32 MB still caches several full tracks.

You'll see:

```
🎵 SoundWave server on http://localhost:5000
   DJPunjab index: 4082
   DJJohal index: 24698
   Mr-Jatt index: 59724
```

**Wait for those three numbers.** Search is poor until the 85,304 tracks load.

## 6. Open it

In Chrome on the same phone: **http://localhost:5000**

That's the full app — search, full-length playback, EQ, visualizer, lyrics,
playlists, offline saves.

---

## Keeping Android from killing it

Android aggressively terminates background apps. Two settings make the
difference between "works" and "works for four minutes":

1. **Acquire a wakelock** in Termux:
   ```bash
   termux-wake-lock
   ```
   Release it later with `termux-wake-unlock`.

2. **Disable battery optimization** for Termux:
   Android Settings → Apps → Termux → Battery → **Unrestricted**.

On Samsung, also check Settings → Battery → *Sleeping apps* and make sure Termux
is not listed there.

## Running it in the background

Termux stops when you swipe it away. To keep it alive:

```bash
pkg install -y termux-services
nohup env AUDIO_CACHE_MB=32 PORT=5000 npm run start > ~/soundwave.log 2>&1 &
```

Then check on it with `tail -f ~/soundwave.log`, and stop it with
`pkill -f server.js`.

## Updating

```bash
cd ~/soundwave
git pull && npm run install:all && npm run build
pkill -f server.js
AUDIO_CACHE_MB=32 npm run start
```

---

## Limitations, honestly

- **Screen off = risk.** Even with a wakelock, some OEMs (Xiaomi, Oppo, Vivo)
  kill background processes. If playback stops when the screen locks, that is
  the OS, not the app.
- **No home-screen app icon over plain HTTP.** Android only installs a PWA from
  `https://` or `localhost`. Opening `http://localhost:5000` works fully but
  Chrome may not offer "Add to Home screen". Workarounds: run Tailscale on the
  phone (`tailscale funnel 5000` gives an `https://` URL), or use Firefox, which
  is more permissive about shortcuts.
- **Battery.** Running Node plus audio decoding costs noticeably more than a
  normal music app. Expect it to be visible.
- **Storage.** The app itself is 4.3 MB. Offline-downloaded songs are the real
  consumer — a 320 kbps track is roughly 10 MB.
- **`localhost` only.** The server listens on the phone, so other devices on
  your Wi-Fi can reach it at `http://<phone-IP>:5000` if you want that.

## What was and wasn't verified

Verified on x86 Linux: zero native modules, zero `binding.gyp` files, no
absolute-path or `$HOME` assumptions, 4.3 MB on disk, and a healthy boot at
**41 MB RSS** with `AUDIO_CACHE_MB=32` and all three provider indexes loaded.

**Not verified: an actual Android device.** There is no ARM Android environment
available here. Node on Termux is well-established and nothing in this codebase
should care about the architecture, but if a step fails on your phone, that is
new information — send the exact error.
