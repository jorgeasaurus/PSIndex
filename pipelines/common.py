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
    """The version this run found, else the last committed one.

    The policy for a failed PowerShell Gallery lookup: the refresh still goes through (its cmdlets
    are current) and keeps the last known version, with a workflow warning so the stale label is
    visible. Only with no committed version either does the manifest get null, which
    scripts/check-shrink.py then refuses.
    """
    if found:
        return found
    previous = previous_manifest_version(source_id)
    if previous:
        print(f"::warning::{source_id}: PowerShell Gallery lookup failed; keeping the previous version {previous}")
    return previous
