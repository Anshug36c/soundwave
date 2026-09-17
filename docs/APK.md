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

## Known unverified piece

**The `nodejs-mobile` Gradle coordinate in `app/build.gradle.kts` could not be
confirmed.** The upstream project (JaneaSystems) is unmaintained; the live fork
is `github.com/nodejs-mobile`, which is active (Node 24 base, commits within the
last month). If the build fails with `Could not find com.janeasystems:nodejs-mobile`,
that single line is the cause — check that repository's README for the current
coordinate and change only it.

The matching import in `MainActivity.kt`
(`com.janeasystems.nodejs_mobile.NodeJsMobile`) would need to change with it.

Everything else follows the documented integration pattern: copy
`assets/nodejs-project` to `filesDir`, then start the runtime with a script path.

## What was verified locally

- The staged bundle boots and serves the app: `/api/health` returns loaded
  indexes and `GET /` returns 200 with the real `assets/index-` markup, at 33 MB
  RSS.
- `main.js` parses; every `R.string` / `R.layout` / `R.id` referenced from Kotlin
  exists in the resources.
- Workflow YAML is valid; `main.js` survives a failed import without exiting, so
  a broken bundle shows a readable error instead of a dead WebView.

## What was not verified

No APK was compiled — there is no JDK 17 or Android SDK in the development
sandbox. The Gradle build, the `nodejs-mobile` dependency resolution, and
behaviour on a real phone are all untested. Expect the first CI run to surface
the coordinate issue above.
