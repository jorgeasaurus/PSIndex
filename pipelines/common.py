"""Helpers shared by the pipelines. pipelines/refresh.sh runs each parser with PYTHONPATH=pipelines."""
import json
import os
import re
import urllib.error
import urllib.request
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


def parse_dependencies(atom):
    """Module name -> version from a PowerShell Gallery package entry's <d:Dependencies>.

    The feed lists them as "Az.Accounts:[5.1.0, ):|Az.Advisor:3.0.0:|..." (a range or a bare
    minimum); that lower bound is the version the package was released with.
    """
    m = re.search(r"<d:Dependencies>([^<]*)</d:Dependencies>", atom)
    if not m:
        return {}
    return dict(re.findall(r"([\w.]+):[\[(]?\s*([\d.]+)", m.group(1)))


def gallery_dependencies(package, version):
    """The module versions a PowerShell Gallery package release depends on, or {} if the lookup fails."""
    url = f"https://www.powershellgallery.com/api/v2/Packages(Id='{package}',Version='{version}')"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "PSIndex"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            deps = parse_dependencies(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError) as e:
        print(f"::warning::{package} {version}: PowerShell Gallery lookup failed ({e}); module versions left blank")
        return {}
    print(f"  {package} {version}: {len(deps)} module versions from the PowerShell Gallery")
    return deps
