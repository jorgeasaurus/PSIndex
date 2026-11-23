#!/usr/bin/env python3
"""Refuse a data refresh that silently lost entries.

Usage: check-shrink.py <source-id> [max-drop-ratio]

Compares data/<id>/manifest.json in the working tree against the committed
version (git HEAD). Exits 1 when the entry count dropped by more than the
ratio (default 0.10), which usually means an upstream clone or fetch failed
and the pipeline wrote a partial dataset.
"""
import json
import subprocess
import sys
from pathlib import Path

src = sys.argv[1]
limit = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10
path = Path("data") / src / "manifest.json"

new = len(json.loads(path.read_text(encoding="utf-8"))["d"])
try:
    old_raw = subprocess.run(["git", "show", f"HEAD:{path.as_posix()}"], check=True, capture_output=True, text=True).stdout
    old = len(json.loads(old_raw)["d"])
except subprocess.CalledProcessError:
    print(f"{src}: no committed manifest, accepting {new} entries")
    sys.exit(0)

drop = (old - new) / old if old else 0
print(f"{src}: {old} -> {new} entries ({-drop:+.1%})")
if drop > limit:
    print(f"::error::{src} lost {old - new} entries ({drop:.1%} > {limit:.0%}); refusing to commit a partial refresh")
    sys.exit(1)
