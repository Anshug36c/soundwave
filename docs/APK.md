# Building the standalone Android APK

The APK contains the **real backend**. `nodejs-mobile` embeds Node.js as a native
library inside the app; on launch it runs `server/server.js` in-process on
`127.0.0.1:5000` and a WebView loads it. No server anywhere, no Termux, no
network for the UI.

```
APK starts → assets/nodejs-project copied to filesDir
           → embedded Node runs main.js → Express on 127.0.0.1:5000
           → WebView polls /api/health → loads the app
```

---

## Get the APK (no Android Studio)

The build runs in GitHub Actions and attaches the APK as an artifact:

1. Open the repo → **Actions** → **Build Android APK** → **Run workflow**
2. Wait for the job (roughly 5–10 minutes)
3. Download `soundwave-apk` from the run's Artifacts
4. On the phone: allow "install unknown apps" and open the APK

It also builds automatically on pushes that touch `android/`, `server/`, or
`client/`.

The APK is **unsigned (debug build)**, which is fine for installing directly.
Publishing to the Play Store needs a signing key.

## Why this works at all

Two properties of the backend make embedding possible, both verified rather than
assumed:

- **Zero native dependencies.** 0 `.node` binaries and 0 `binding.gyp` files in
  the tree, so nothing needs cross-compiling for arm64.
- **No `--openssl-legacy-provider`.** JioSaavn decryption is pure JS
  (`server/des.js`). That flag was a hard blocker for embedded runtimes.

The server also spawns no child processes, which embedded runtimes disallow.

## Layout, and why it must not be flattened

```
assets/nodejs-project/
├── main.js              entry point (committed)
├── server/              server.js, auth.js, des.js, package.json, node_modules
└── client/dist/         the built web client
```

`server.js` locates the client with `path.join(__dirname, '../client/dist')`. If
`server.js` is flattened to the project root, `__dirname` becomes the root and
that path resolves to `nodejs-project/../client/dist` — **outside** the project —
so `fs.existsSync` fails, the static middleware is never mounted, and every route
returns 404. This was found by testing, not by reading; both layouts were run.

The CI job verifies the staged bundle actually boots and serves `assets/index-`
before it builds the APK, so a layout regression fails the build instead of
shipping a dead app.

## Tuning

| File | What to change |
| --- | --- |
| `assets/nodejs-project/main.js` | `AUDIO_CACHE_MB` (default 32; the 160 MB server default would put the process near 250 MB and invite Android to kill it) |
| `app/build.gradle.kts` | `applicationId`, `versionCode`, ABI list |
| `MainActivity.kt` | `PORT`, startup timeout |

---

## Status: BLOCKED — the native integration layer does not exist

This was investigated to a conclusion rather than left as a guess. The findings,
all verified:

1. **`com.janeasystems:nodejs-mobile` is not on Maven Central.** A search returns
   zero hits, and `com/janeasystems/nodejs-mobile/maven-metadata.xml` is a 404.
   CI failed with exactly this: `Could not find com.janeasystems:nodejs-mobile:0.10.1`.
2. **The project distributes as a GitHub Release ZIP**, not a Maven artifact.
   `nodejs-mobile-v18.20.4-android.zip` (55 MB).
3. **That ZIP contains no Java/Kotlin layer.** Its entire contents are:
   ```
   bin/arm64-v8a/libnode.so    62.48 MB
   bin/armeabi-v7a/libnode.so  58.72 MB
   bin/x86_64/libnode.so       65.36 MB
   include/node/**             634 stock Node headers
   ```
   No `.aar`, no `.jar`, no executable `node` binary, and no
   nodejs-mobile-specific header.
4. **`libnode.so` exports no entry point.** `readelf --dyn-syms` over the
   extracted x86_64 library (65,957 symbols) shows no `nodejs_start` and nothing
   matching `nodejs*` except `node::per_process::node_start_time`. What it does
   export is N-API (`node_api_*`) and Node's C++ internals.

**Conclusion:** there is no drop-in dependency. Driving this library means
writing JNI C++ against Node's embedder API
(`NewIsolate → CreateEnvironment → LoadEnvironment → SpinEventLoop`), building it
with the NDK for arm64, and marshalling the channel between Kotlin and C++. That
is real native work requiring a device to test against, not a version bump.

The `android/` scaffold in this repository is therefore **not buildable**. It is
kept because the parts that were verified are still useful — see below — but do
not expect `gradle assembleDebug` to succeed.

## What was verified and still holds

The CI pipeline itself works, and proved the important part:

- The staged Node bundle **boots and serves the real app on a CI runner**
  (`GET / → 200` with `assets/index-` markup, provider indexes loaded). So the
  backend is genuinely portable; only the Android host layer is missing.
- A layout regression is caught before the APK is built. `server.js` resolves the
  client with `path.join(__dirname, '../client/dist')`; flattening `server.js` to
  the project root makes it point outside the project, the static middleware
  never mounts, and every route 404s. Both layouts were run and the broken one
  produced `GET / → 404`.
- `main.js` keeps the process alive on `uncaughtException`. The server's own
  handler calls `exit(1)` for a supervisor, but there is none inside an APK, and
  exiting would leave the WebView pointing at a dead port.

## The alternative that works today

`docs/TERMUX.md`. Termux runs Node.js on Android, so the unmodified backend runs
on the phone — verified as feasible (zero native modules, zero `binding.gyp`, no
absolute paths, 4.3 MB on disk, 41 MB RSS). It is not a single APK, but it is
standalone-on-device and needs no unverified code.
