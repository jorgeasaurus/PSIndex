"""Helpers shared by the pipelines. pipelines/refresh.sh runs each parser with PYTHONPATH=pipelines."""
import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def source_dir(source_id):
    """data/<source_id>/ — the committed output of the last successful run. Read-only to parsers."""
    return REPO_ROOT / "data" / source_id


def output_dir():
    """Where this run writes manifest.json, descriptions.json and modules/.

    pipelines/refresh.sh points PSINDEX_OUT at an empty directory and swaps it in for
    data/<source>/ only after the parser succeeds, so a run never mixes with the last one.
    """
    out = os.environ.get("PSINDEX_OUT")
    if not out:
        raise SystemExit("PSINDEX_OUT is not set; run this parser through pipelines/refresh.sh <source>")
    return Path(out)


def previous_manifest_version(source_id):
    """The source version the last successful run committed (manifest.json "v"), or None."""
    try:
        return json.loads((source_dir(source_id) / "manifest.json").read_text(encoding="utf-8")).get("v")
    except (OSError, ValueError):
        return None


def source_version(found, source_id):
    """The source version to record in manifest.json "v": always a string.

    The one rule for every parser that discovers its version (MECM's is a constant). The
    version this run found wins.
    If it found none (a failed PowerShell Gallery lookup, or a docs folder name without one), the
    last committed version is kept, with a workflow warning so the stale label is visible.
    With neither, the run fails: a manifest never records an unknown version.
    """
    if found:
        return found
    previous = previous_manifest_version(source_id)
    if previous:
        print(f"::warning::{source_id}: no version found this run; keeping the previous version {previous}")
        return previous
    raise SystemExit(f"::error::{source_id}: no version found and none committed before")
