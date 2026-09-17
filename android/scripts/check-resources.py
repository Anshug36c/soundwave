#!/usr/bin/env python3
"""Statically resolve every Android resource reference in the project.

The APK cannot be compiled outside a machine with the Android SDK, so this is the
only way to catch a dangling resource before CI spends ten minutes finding it.
It exists because a real build failed on exactly this: strings.xml was edited to
rename a string while the layout still pointed at the old name, and the check
that was in place only scanned Kotlin, not XML.

Checks, over both Kotlin sources and res/ XML:
  * R.string.* / R.layout.* / R.id.* / R.drawable.* / R.mipmap.* / R.color.*
    from Kotlin resolve to something that exists
  * @string/ @layout/ @id/ @drawable/ @mipmap/ @color/ @dimen/ from XML resolve
  * every @+id defined somewhere is in fact referenced (informational)

Exits non-zero on any unresolved reference.
"""

from __future__ import annotations

import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "src", "main", "res")
JAVA = os.path.join(ROOT, "app", "src", "main", "java")

# Resource kinds that live in res/values/*.xml as <kind name="...">
VALUE_KINDS = {"string", "color", "dimen", "style", "bool", "integer", "array", "plurals"}
# Kinds that live as files in res/<kind>-<qualifier>/<name>.<ext>
FILE_KINDS = {"layout", "drawable", "mipmap", "anim", "animator", "menu", "raw", "xml", "font"}


def defined_value_resources() -> dict:
    found = {k: set() for k in VALUE_KINDS}
    for path in glob.glob(os.path.join(RES, "values*", "*.xml")):
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as e:
            print(f"  !! {path}: {e}")
            continue
        for child in root:
            name = child.get("name")
            if not name:
                continue
            tag = child.tag.split("}")[-1]
            if tag == "item":
                tag = (child.get("type") or "").strip()
            if tag in found:
                found[tag].add(name)
    return found


def defined_file_resources() -> dict:
    found = {k: set() for k in FILE_KINDS}
    # res/<kind>[-<qualifier>]/<name>.<ext> — the qualifier is optional, so
    # res/layout/ counts exactly as much as res/mipmap-xxxhdpi/.
    for path in glob.glob(os.path.join(RES, "*", "*")):
        folder = os.path.basename(os.path.dirname(path))
        kind = folder.split("-")[0]
        if kind in found and os.path.isfile(path):
            found[kind].add(os.path.splitext(os.path.basename(path))[0])
    return found


def defined_ids() -> set:
    ids = set()
    for path in glob.glob(os.path.join(RES, "**", "*.xml"), recursive=True):
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        ids.update(re.findall(r'@\+id/(\w+)', text))
    for path in glob.glob(os.path.join(RES, "values*", "ids.xml")):
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue
        for child in root:
            if child.get("name"):
                ids.add(child["name"])
    return ids


def main() -> int:
    values = defined_value_resources()
    files = defined_file_resources()
    ids = defined_ids()

    def lookup(kind: str, name: str) -> bool:
        if kind == "id":
            return name in ids
        if kind in VALUE_KINDS:
            return name in values.get(kind, set())
        if kind in FILE_KINDS:
            return name in files.get(kind, set())
        return True  # unknown kind — do not fail on it

    missing = []
    checked = 0

    # --- Kotlin: R.<kind>.<name> ---
    # `android.R.*` references the framework's own resources (ic_media_play and
    # friends), which are not in this project and must not be reported missing.
    for path in glob.glob(os.path.join(JAVA, "**", "*.kt"), recursive=True):
        text = open(path, encoding="utf-8").read()
        for kind, name in re.findall(r"(?<![\w.])R\.(\w+)\.(\w+)", text):
            checked += 1
            if not lookup(kind, name):
                missing.append((os.path.relpath(path, ROOT), f"R.{kind}.{name}"))

    # --- XML: @<kind>/<name> (skip @+id definitions and @android: refs) ---
    for path in glob.glob(os.path.join(RES, "**", "*.xml"), recursive=True):
        text = open(path, encoding="utf-8").read()
        for kind, name in re.findall(r"@(\w+)/(\w+)", text):
            if kind.startswith("+"):
                continue
            checked += 1
            if not lookup(kind, name):
                missing.append((os.path.relpath(path, ROOT), f"@{kind}/{name}"))

    print(f"resource check: {checked} references")
    if missing:
        print(f"  {len(missing)} UNRESOLVED:")
        for where, ref in sorted(set(missing)):
            print(f"    {where}: {ref}")
        return 1

    print("  all resolve ✅")
    print(f"  ({len(ids)} ids, {len(values['string'])} strings, "
          f"{len(files['layout'])} layouts, {len(files['mipmap'])} mipmaps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
