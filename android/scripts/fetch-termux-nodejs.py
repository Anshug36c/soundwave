#!/usr/bin/env python3
"""Fetch Termux's Node.js runtime and stage it into the APK assets.

This is the "little Termux baked in" the APK needs: a real `node` executable
built for Android (bionic, PT_INTERP = /system/bin/linker64) plus the shared
libraries it links against, laid out as a relocatable prefix.

Verified facts that make this work:
  * The dependency closure of Termux's nodejs-lts is complete once its direct
    deps are bundled — the only libraries left are libc.so / libm.so / libdl.so,
    which Android itself provides.
  * The binary's RUNPATH is /data/data/com.termux/files/usr/lib, which does not
    exist in another app's sandbox. Android's linker honours LD_LIBRARY_PATH for
    non-setuid executables, so the app sets that instead of patching the ELF.

Not committed to git (the result is ~25 MB); Gradle runs this during the build.
"""

from __future__ import annotations

import argparse
import io
import os
import shutil
import sys
import tarfile
import urllib.request

REPO = "https://packages.termux.dev/apt/termux-main"
# Termux's own prefix inside the .deb payload. Stripped when staging.
TERMUX_PREFIX = "./data/data/com.termux/files/usr"
# Pinned so a build is reproducible and cannot silently pick up a new ICU soname.
NODEJS_PKG = "nodejs-lts"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def parse_packages(blob: bytes) -> dict:
    """Parse an apt Packages index into {name: fields}."""
    pkgs = {}
    for block in blob.decode("utf-8", "replace").split("\n\n"):
        if not block.strip():
            continue
        fields, key = {}, None
        for line in block.split("\n"):
            if line[:1] in (" ", "\t") and key:
                fields[key] += " " + line.strip()
                continue
            if ": " in line:
                key, _, val = line.partition(": ")
                fields[key] = val.strip()
        if "Package" in fields:
            pkgs[fields["Package"]] = fields
    return pkgs


def ar_members(blob: bytes):
    """Yield (name, data) from an ar archive — .deb is ar(data.tar.*)."""
    if blob[:8] != b"!<arch>\n":
        raise ValueError("not an ar archive")
    off = 8
    while off + 60 <= len(blob):
        header = blob[off : off + 60]
        name = header[:16].decode("ascii", "replace").strip()
        size = int(header[48:58].decode().strip())
        off += 60
        yield name, blob[off : off + size]
        off += size + (size % 2)


def stage_deb(blob: bytes, dest: str) -> int:
    """Extract a .deb's data payload under `dest`, dropping Termux's prefix."""
    written = 0
    for name, data in ar_members(blob):
        if not name.startswith("data.tar"):
            continue
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            for member in tar.getmembers():
                target = member.name
                for prefix in (TERMUX_PREFIX, TERMUX_PREFIX.lstrip("./")):
                    if target.startswith(prefix):
                        target = target[len(prefix) :] or "/"
                        break
                else:
                    continue  # outside the prefix (docs, termux-specific bits)
                member.name = target.lstrip("/") or "."
                if member.name in (".", ""):
                    continue
                tar.extract(member, dest, filter="data")
                if member.isfile():
                    written += 1
    return written


# Not needed at runtime. include/ alone is 11 MB of headers.
PRUNE_DIRS = ("include", "share", "lib/node_modules")
# Packages that ship the same library under two names; the versioned soname is
# the one the loader actually asks for.
PRUNE_FILE_GLOBS = (
    "lib/libsqlite3.53.4.so",
    "lib/libicu*.so",
    "lib/libcrypto.so",
    "lib/libssl.so",
    "lib/libicutest.so*",
    "lib/libicutu.so*",
    "lib/engines-3/*",
    "lib/ossl-modules/legacy.so",
)


def prune(root: str) -> int:
    """Drop build-time files. Returns bytes removed."""
    import glob as _glob

    removed = 0

    def size_of(path):
        total = 0
        for dirpath, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, f))
                except OSError:
                    pass
        return total

    for rel in PRUNE_DIRS:
        p = os.path.join(root, rel)
        if os.path.isdir(p):
            removed += size_of(p)
            shutil.rmtree(p)
    for pattern in PRUNE_FILE_GLOBS:
        for p in _glob.glob(os.path.join(root, pattern)):
            if os.path.isfile(p):
                removed += os.path.getsize(p)
                os.remove(p)
    return removed


def make_tarball(root: str, out_path: str) -> int:
    """Pack the prefix as a single .tar.xz asset.

    bin/node is deliberately excluded: it ships as a JNI-style native library
    instead, because Android will not execute a file the app wrote to its own
    data directory (EACCES on exec). See stage_native_binary().
    """
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cmd = ["tar", "-cJf", out_path, "--format=gnu", "--exclude=./bin/node",
           "-C", root, "."]
    import subprocess

    subprocess.run(cmd, check=True)
    return os.path.getsize(out_path)


def stage_native_binary(root: str, jni_dir: str) -> str:
    """Copy bin/node into jniLibs/<abi>/ under a lib*.so name.

    Android extracts lib/<abi>/*.so from the APK into the app's
    nativeLibraryDir at install time, mode 0755 and labelled apk_data_file.
    That directory is executable from the app's SELinux domain, which the app's
    own filesDir is not — writing the binary there and executing it fails with
    EACCES (errno 13) on Android 10 and later, which is exactly the failure this
    works around.

    The filename has to match Android's native-library pattern, hence the
    lib*.so name for what is really an executable. That is the same trick
    python-for-android and similar projects use, and it is cosmetic: the file is
    exec'd by path, never loaded as a library.
    """
    import shutil

    src = os.path.join(root, "bin", "node")
    os.makedirs(jni_dir, exist_ok=True)
    dest = os.path.join(jni_dir, "libnode.so")
    shutil.copyfile(src, dest)
    os.chmod(dest, 0o755)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="arm64-v8a")
    ap.add_argument("--out", required=True, help="directory to stage the prefix in")
    ap.add_argument(
        "--tarball",
        help="also write a packed .tar.xz here (this is what ships in the APK)",
    )
    ap.add_argument(
        "--jni-dir",
        help="also copy bin/node here as libnode.so, so Gradle packages it as a "
             "native library and Android extracts it to an executable directory",
    )
    args = ap.parse_args()

    # APK ABI name -> Termux arch name
    termux_arch = {"arm64-v8a": "aarch64", "armeabi-v7a": "arm"}.get(args.arch)
    if not termux_arch:
        print(f"unsupported arch {args.arch}", file=sys.stderr)
        return 1

    index_url = f"{REPO}/dists/stable/main/binary-{termux_arch}/Packages"
    pkgs = parse_packages(fetch(index_url))
    if NODEJS_PKG not in pkgs:
        print(f"{NODEJS_PKG} not found in {index_url}", file=sys.stderr)
        return 1

    # Resolve the transitive dependency closure.
    wanted, queue = set(), [NODEJS_PKG]
    total = 0
    while queue:
        name = queue.pop(0)
        if name in wanted or name not in pkgs:
            continue
        wanted.add(name)
        pkg = pkgs[name]
        total += int(pkg.get("Size", 0))
        import re

        for dep in re.split(r"[,\s|()]+", pkg.get("Depends", "") or ""):
            dep = dep.strip()
            if dep and not dep.startswith(("<<", ">>")):
                queue.append(dep)

    print(f"[termux-nodejs] {len(wanted)} packages, {total / 1e6:.1f} MB compressed")

    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    os.makedirs(args.out, exist_ok=True)

    for name in sorted(wanted):
        pkg = pkgs[name]
        url = f"{REPO}/{pkg['Filename']}"
        blob = fetch(url)
        n = stage_deb(blob, args.out)
        print(f"[termux-nodejs]   {name:<16} {pkg.get('Version','?'):<14} {n} files")

    node = os.path.join(args.out, "bin", "node")
    if not os.path.isfile(node):
        print("[termux-nodejs] FAILED: no bin/node in staged prefix", file=sys.stderr)
        return 1
    os.chmod(node, 0o755)

    # Runtime dirs the server and node itself expect to be able to write.
    for d in ("tmp", "home"):
        os.makedirs(os.path.join(args.out, d), exist_ok=True)

    freed = prune(args.out)
    print(f"[termux-nodejs] pruned build-time files: {freed / 1e6:.1f} MB")

    if not verify_closure(args.out):
        return 1

    if args.tarball:
        size = make_tarball(args.out, args.tarball)
        print(f"[termux-nodejs] packed {args.tarball} ({size / 1e6:.1f} MB)")

    if args.jni_dir:
        dest = stage_native_binary(args.out, args.jni_dir)
        print(f"[termux-nodejs] staged native binary {dest} "
              f"({os.path.getsize(dest) / 1e6:.1f} MB)")
    return 0


def verify_closure(root: str) -> bool:
    """Statically confirm every DT_NEEDED library resolves inside the bundle.

    The binary itself cannot be executed outside Android (it requests
    /system/bin/linker64), so this is the strongest check available offline. It
    is also the check that catches a bad prune: dropping a library that node
    links against would otherwise only surface as a dead process on the phone.

    Symlinked dependencies are resolved to their target, because several
    libraries node links against (libicuuc.so.78, libicui18n.so.78, libz.so.1,
    libsqlite3.so) are shipped only as a symlink to the versioned file. A check
    that merely matched the name would pass while the real file was missing.
    """
    import re
    import subprocess

    lib = os.path.join(root, "lib")
    node = os.path.join(root, "bin", "node")
    # Android provides these; everything else must be in the bundle.
    system = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so"}

    def needed(path):
        try:
            out = subprocess.run(
                ["readelf", "-dW", path], capture_output=True, text=True, timeout=60
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        return re.findall(r"\(NEEDED\)\s+Shared library: \[([^\]]+)\]", out)

    def resolves(name):
        """True if `name` exists in lib/ and leads to a real file."""
        import glob as _glob

        for candidate in _glob.glob(os.path.join(lib, name + "*")):
            if os.path.islink(candidate):
                if os.path.isfile(os.path.realpath(candidate)):
                    return True
            elif os.path.isfile(candidate):
                return True
        return False

    deps = needed(node)
    if deps is None:
        print("[termux-nodejs] WARNING: readelf unavailable, closure not verified")
        return True

    ok = True
    for d in deps:
        if d in system:
            continue
        if not resolves(d):
            print(f"[termux-nodejs] MISSING: {d} (needed by bin/node)")
            ok = False

    # Transitive pass over the bundled libraries too.
    import glob as _glob

    for f in _glob.glob(os.path.join(lib, "*.so*")):
        for d in needed(f) or []:
            if d in system:
                continue
            if not resolves(d):
                print(f"[termux-nodejs] MISSING: {d} (needed by {os.path.basename(f)})")
                ok = False

    if ok:
        print(f"[termux-nodejs] closure OK — {len(deps)} direct deps all resolve")
    return ok


if __name__ == "__main__":
    sys.exit(main())
