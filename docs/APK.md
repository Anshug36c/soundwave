# The standalone Android APK

The APK contains a **real Node.js runtime and the real backend**. It needs no
server, no hosting, and no Termux install — the runtime travels inside the APK.

```
APK install → assets/runtime/usr.tar.xz (22 MB) unpacked to filesDir/runtime/usr
            → assets/nodejs-project staged to filesDir/runtime/nodejs-project
            → ProcessBuilder spawns usr/bin/node with LD_LIBRARY_PATH set
            → Express serves everything on 127.0.0.1:5000
            → WebView loads it
```

---

## Get the APK

1. Repo → **Actions** → **Build Android APK** → **Run workflow**
2. Wait ~10 minutes
3. Download `soundwave-apk` from the run's Artifacts
4. Install on the phone (allow "unknown apps")

It also builds on pushes touching `android/`, `server/`, or `client/`. The APK is
an unsigned debug build, which installs fine; Play Store publishing needs a
signing key. Expect roughly **25 MB**.

## How the runtime works

`android/scripts/fetch-termux-nodejs.py` downloads Termux's `nodejs-lts` plus its
full dependency closure from `packages.termux.dev`, prunes build-time files, and
packs the result. Nine packages, 23.9 MB compressed on the wire, 90 MB unpacked,
**22 MB as the shipped asset**:

```
nodejs-lts 24.18.0-1   libc++ 29        libicu 78.3      openssl 1:3.6.3
c-ares 1.34.8          libsqlite 3.53.4 zlib 1.3.2       ca-certificates
resolv-conf 1.3
```

Pruning drops `include/` (11 MB of headers), `share/`, `lib/node_modules`, and
duplicate soname symlinks — 57 MB in total. `bin/node` needs no stripping;
Termux already ships it stripped. `libicudata.so` is 32 MB on its own and cannot
be removed, because Node aborts without full ICU.

The one thing that makes the bundle relocatable is `LD_LIBRARY_PATH`. The
binary's `RUNPATH` is `/data/data/com.termux/files/usr/lib`, which does not exist
in another app's sandbox; Android's linker honours `LD_LIBRARY_PATH` for
non-setuid executables, which is how Termux itself runs binaries from a
non-default prefix. `MainActivity` also sets `TMPDIR` and `HOME` inside the
prefix, since the binary contains 20 hardcoded Termux paths and those two are the
ones it falls back to.

## What is verified

| Check | Result |
| --- | --- |
| `bin/node` is an Android binary | ELF aarch64, `PT_INTERP = /system/bin/linker64` |
| Dependency closure complete | 11 `DT_NEEDED`, 8 bundled, only `libc/libm/libdl` from the system |
| Transitive closure complete | no bundled library needs anything outside the bundle |
| Closure check catches a break | deleting `libcares.so` makes `verify_closure()` return `False` |
| Asset format matches the Kotlin reader | GNU tar, xz, 62 relative paths, `bin/node` mode `0o755` |
| The staged server boots and serves | CI runs it: `GET / → 200` with `assets/index-` |
| Backend is portable | 0 native modules, 0 `binding.gyp`, no `child_process`, 4.3 MB |

## What is not verified

**The APK has never run on a phone, and it cannot be tested here.** The bundled
binary requires Android's linker (`/system/bin/linker64`), so it cannot execute
on a Linux build machine — the local test attempt failed with
`cannot execute: required file not found`, which is the missing interpreter, not
a missing library. Everything above is static analysis of the ELF plus a boot
test of the *server*, not of the runtime.

The specific things only a phone can settle:

- Whether this device's Android permits `exec()` on app-private storage. Termux
  does exactly this, so it works in general, but hardened OEM ROMs may differ.
- Whether the linker accepts the bundled libraries on the target API level.
- Actual memory use and indexing time on real hardware.
- Whether background playback survives. The Node process is a child of the
  activity and is destroyed in `onDestroy`, so playback stops when the app is
  swiped away. A foreground service is the fix if that matters.

If it fails, `MainActivity` shows the last four lines of the Node process output
on screen, and the same lines are in `filesDir/runtime/node.log`
(`adb shell run-as com.soundwave.app cat filesDir/runtime/node.log`). That is
deliberate: an unrunnable binary should say why.

## Why not nodejs-mobile

Investigated to a conclusion rather than guessed. The release ships
`bin/<abi>/libnode.so` and 634 stock Node headers — no `.aar`, no `.jar`, no
`node` executable, and `readelf --dyn-syms` over the library (65,957 symbols)
shows no entry point such as `nodejs_start`, only `node_api_*` and Node's C++
internals. Using it means hand-written JNI against Node's embedder API. Running
Termux's actual `node` binary avoids that entirely and needs no NDK.

## Layout note

`server.js` locates the client with `path.join(__dirname, '../client/dist')`, so
the staged tree must mirror the repository:

```
runtime/nodejs-project/
├── main.js
├── server/          server.js, auth.js, des.js, package.json, node_modules
└── client/dist/
```

Flattening `server.js` to the project root makes `__dirname/../client/dist`
resolve outside the project, the static middleware never mounts, and every route
returns 404. Both layouts were run; the broken one produced `GET / → 404`. CI
asserts `assets/index-` is served before it builds the APK.

`main.js` also overrides `uncaughtException` to keep the process alive: the
server's own handler calls `exit(1)` for a supervisor, but there is none inside
an APK, and exiting would leave the WebView pointing at a dead port.

## Tuning

| File | What to change |
| --- | --- |
| `assets/nodejs-project/main.js` | `AUDIO_CACHE_MB` (default 32) |
| `scripts/fetch-termux-nodejs.py` | `NODEJS_PKG` — `nodejs` (26.x) instead of `nodejs-lts` (24.x) |
| `MainActivity.kt` | `PORT`, `RUNTIME_VERSION`, the two-minute health timeout |
| `app/build.gradle.kts` | `applicationId`, `versionCode` |

Bump `RUNTIME_VERSION` whenever the runtime or staging layout changes
incompatibly, or installed devices will keep their old copy.
