#!/usr/bin/env python3
"""Refuse a data refresh that silently lost entries.

Usage: check-shrink.py <source-id> [max-drop-ratio]

Compares data/<id>/manifest.json in the working tree against the committed
version (git HEAD). Exits 1 when the entry count dropped by more than the
ratio (default 0.10), which usually means an upstream clone or fetch failed
and the pipeline wrote a partial dataset. Also exits 1 when the recorded
version disappears (null or 0.0.0), which means a version lookup failed.
"""
import json
import subprocess
import sys
from pathlib import Path

src = sys.argv[1]
limit = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10
path = Path("data") / src / "manifest.json"

new_doc = json.loads(path.read_text(encoding="utf-8"))
new = len(new_doc["d"])
try:
    old_raw = subprocess.run(["git", "show", f"HEAD:{path.as_posix()}"], check=True, capture_output=True, text=True).stdout
    old_doc = json.loads(old_raw)
    old = len(old_doc["d"])
except subprocess.CalledProcessError:
    print(f"{src}: no committed manifest, accepting {new} entries")
    sys.exit(0)

drop = (old - new) / old if old else 0
print(f"{src}: {old} -> {new} entries ({-drop:+.1%})")
if drop > limit:
    print(f"::error::{src} lost {old - new} entries ({drop:.1%} > {limit:.0%}); refusing to commit a partial refresh")
    sys.exit(1)

# A version that disappears means a lookup (e.g. PowerShell Gallery) failed, not a real release.
old_v, new_v = old_doc.get("v"), new_doc.get("v")
if old_v and old_v != "0.0.0" and (not new_v or new_v == "0.0.0"):
    print(f"::error::{src} version went from {old_v!r} to {new_v!r}; refusing to commit a degraded refresh")
    sys.exit(1)
