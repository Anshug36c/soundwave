# The standalone Android APK

The APK contains a **real Node.js runtime and the real backend**. It needs no
server, no hosting, and no Termux install — the runtime travels inside the APK.

```
APK install → Android unpacks lib/arm64-v8a/libnode.so to nativeLibraryDir
            → assets/runtime/usr.tar.xz (13 MB) unpacked to filesDir/runtime/usr
            → assets/nodejs-project staged to filesDir/runtime/nodejs-project
            → ProcessBuilder spawns nativeLibraryDir/libnode.so, LD_LIBRARY_PATH
              pointing at filesDir/runtime/usr/lib
            → Express serves everything on 127.0.0.1:5000
            → WebView loads it
```

The executable and its libraries live in different places on purpose — see
[Why the binary is not next to its libraries](#why-the-binary-is-not-next-to-its-libraries).

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

The binary's `RUNPATH` is `/data/data/com.termux/files/usr/lib`, which does not
exist in another app's sandbox. Android's linker honours `LD_LIBRARY_PATH` for
non-setuid executables, so `MainActivity` points it at the unpacked libraries.
`TMPDIR` and `HOME` are set inside the prefix too, since the binary contains 20
hardcoded Termux paths and those two are the ones it falls back to.

## Why the binary is not next to its libraries

The first build shipped `bin/node` inside the tarball and ran it from
`filesDir`. On a real phone that failed:

```
startup failed: cannot run program "/data/user/0/com.soundwave.app/files/
runtime/usr/bin/node": error=13, Permission denied
```

`errno 13` on `exec()`, with the file present and mode 0755. Android refuses to
execute a file that an app wrote into its own data directory; `nativeLibraryDir`
is extracted by the installer and labelled differently, so it is executable.

So the executable ships as `lib/arm64-v8a/libnode.so` — the `lib*.so` name is
what makes Gradle package it as a native library, and it is cosmetic, since the
file is `exec`'d by path and never loaded as a library. `extractNativeLibs="true"`
in the manifest is what makes the installer unpack it rather than leaving it
compressed inside the APK. The 45 MB binary then costs about 15 MB compressed
instead of 13 MB in the tarball, and the tarball drops to 12.7 MB.

Termux was checked rather than assumed here: its own 29 MB
`libtermux-bootstrap.so` is a **JNI shared object** loaded with
`System.loadLibrary`, not an executed binary, so Termux does not depend on
executing from app storage either.

## What is verified

| Check | Result |
| --- | --- |
| `bin/node` is an Android binary | ELF aarch64, `PT_INTERP = /system/bin/linker64` |
| Dependency closure complete | 11 `DT_NEEDED`, 8 bundled, only `libc/libm/libdl` from the system |
| Transitive closure complete | no bundled library needs anything outside the bundle |
| Closure check catches a break | deleting `libcares.so` makes `verify_closure()` return `False` |
| Asset format matches the Kotlin reader | GNU tar, xz, 62 relative paths, `bin/node` mode `0o755` |
| Every library node needs survives extraction | checked against the **tarball**, simulating the extractor: `libicuuc.so.78` and `libicui18n.so.78` ship only as symlinks, so a name-only check passes while the device is missing them. Deleting `libicuuc.so.78.3` makes the check report `libicuuc.so.78` as missing |
| The staged server boots and serves | CI runs it: `GET / → 200` with `assets/index-` |
| Every resource reference resolves | `check-resources.py`, 10 refs; fails on both a dangling XML `@string/` and a dangling Kotlin `R.string.` — proven by reintroducing each |
| Kotlin typechecks against android-34 | `typecheck-kotlin.sh`; reproduces the exact CI error (`'==' cannot be applied to 'String?' and 'Long'`) at the same line and column when the bug is reintroduced |
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
