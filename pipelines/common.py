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


def keep_previous_versions(versions, modules, source_id):
    """Fill in modules whose PowerShell Gallery lookup failed.

    `versions` maps module name -> version ('' or None when the lookup failed) and is updated in
    place from the module files the last successful run committed to data/<source_id>/modules/.
    """
    kept = []
    for module in modules:
        if versions.get(module):
            continue
        try:
            previous = json.loads((source_dir(source_id) / "modules" / f"{module}.json").read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            continue
        if previous:
            versions[module] = previous
            kept.append(module)
    if kept:
        print(f"  Gallery lookup failed for {', '.join(kept)}; kept previous versions")
