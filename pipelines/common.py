"""Helpers shared by the pipelines. pipelines/refresh.sh runs each parser with PYTHONPATH=pipelines."""
import json
import os
import re
import time
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


GALLERY = "https://www.powershellgallery.com/api/v2"


def _gallery_get(url):
    """GET a PowerShell Gallery feed URL: three attempts with backoff. The body, or None after the last failure."""
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PSIndex"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8")
        except (urllib.error.URLError, OSError) as e:
            if attempt == 2:
                print(f"  PowerShell Gallery request failed: {e}")
                return None
            time.sleep(2 ** attempt)


def gallery_latest_version(package):
    """The latest stable version of a PowerShell Gallery package, or None if the lookup fails."""
    url = f"{GALLERY}/FindPackagesById()?id='{package}'"
    while url:
        body = _gallery_get(url)
        if body is None:
            return None
        versions = re.findall(r"<d:Version>([^<]+)</d:Version>", body)
        latest = re.findall(r"<d:IsLatestVersion[^>]*>([^<]+)</d:IsLatestVersion>", body)
        for version, flag in zip(versions, latest):
            if flag == "true":
                return version
        nxt = re.search(r'<link rel="next" href="([^"]+)"', body)
        url = nxt.group(1).replace("&amp;", "&") if nxt else None
    return None


def previous_module_versions(source_id):
    """Module name -> version as the last successful run committed them (module files' "version")."""
    out = {}
    for f in (source_dir(source_id) / "modules").glob("*.json"):
        try:
            version = json.loads(f.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            continue
        if version:
            out[f.stem] = version
    return out


def gallery_dependencies(package, version, source_id):
    """The module versions a PowerShell Gallery package release depends on.

    If the lookup fails, the last committed module versions are kept (with a warning), as
    source_version does for the source's own version.
    """
    body = _gallery_get(f"{GALLERY}/Packages(Id='{package}',Version='{version}')")
    deps = parse_dependencies(body) if body else {}
    if deps:
        print(f"  {package} {version}: {len(deps)} module versions from the PowerShell Gallery")
        return deps
    print(f"::warning::{source_id}: {package} {version} dependencies unavailable; keeping the previous module versions")
    return previous_module_versions(source_id)


def syntax_from(section):
    """Every parameter set in a SYNTAX section: the docs give one fenced code block per set.

    The sets are joined by a blank line; the site splits them again at each line starting with
    the cmdlet name. Comment lines ("# ParameterSetName") are dropped.
    """
    blocks = re.findall(r"```[^\n]*\n(.*?)```", section, re.DOTALL)
    # Some docs label a set with a "# ..." comment line; the set itself starts at the cmdlet name.
    sets = ["\n".join(l for l in b.splitlines() if not l.lstrip().startswith("#")).strip() for b in blocks]
    return "\n\n".join(s for s in sets if s)


def require_cmdlets(source_id, count):
    """A run that found no cmdlets (an upstream folder renamed or emptied) fails rather than publish an empty source."""
    if not count:
        raise SystemExit(f"::error::{source_id}: no cmdlets found in the docs; refusing to write an empty source")
