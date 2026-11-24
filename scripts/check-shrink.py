#!/usr/bin/env python3
"""Refuse a data refresh that silently lost entries.

Usage: check-shrink.py <source-id> [max-drop-ratio]

Compares data/<id>/manifest.json in the working tree against the committed
version (git HEAD). Exits 1 when the entry count dropped by more than the
ratio (default 0.10; it must lie strictly between 0 and 1), which usually
means an upstream clone or fetch failed and the pipeline wrote a partial
dataset. (Versions are not checked here: a
parser cannot write an unknown one; see pipelines/common.py source_version.)
"""
import json
import subprocess
import sys
from pathlib import Path

if not 2 <= len(sys.argv) <= 3:
    sys.exit("usage: check-shrink.py <source-id> [max-drop-ratio]  (run from the repository root)")
src = sys.argv[1]
try:
    limit = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10
except ValueError:
    limit = None
# Outside (0, 1) the guard is meaningless: <= 0 fails an unchanged manifest, >= 1 (or nan, which
# compares false) never fails.
if limit is None or not 0 < limit < 1:
    sys.exit(f"check-shrink: max-drop-ratio must be a number between 0 and 1 (exclusive) such as 0.10, not {sys.argv[2]!r}")
path = Path("data") / src / "manifest.json"
if not path.is_file():
    sys.exit(f"check-shrink: {path} not found (an unknown source id, or not run from the repository root)")

new_doc = json.loads(path.read_text(encoding="utf-8"))
new = len(new_doc["d"])
try:
    old_raw = subprocess.run(["git", "show", f"HEAD:{path.as_posix()}"], check=True, capture_output=True, text=True).stdout
    old_doc = json.loads(old_raw)
    old = len(old_doc["d"])
except subprocess.CalledProcessError:
    print(f"{src}: no committed manifest, accepting {new} entries")
    sys.exit(0)

change = (new - old) / old if old else 0.0
print(f"{src}: {old} -> {new} entries ({change + 0.0:+.1%})")  # + 0.0 turns -0.0 into 0.0
if old - new > limit * old:
    print(f"::error::{src} lost {old - new} entries ({-change:.2%}, over the {limit:.0%} limit); refusing to commit a partial refresh")
    sys.exit(1)
