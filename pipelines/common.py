"""Helpers shared by the pipelines. pipelines/refresh.sh runs each parser with PYTHONPATH=pipelines."""
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
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


def gallery_module_versions(packages, source_id):
    """Module name -> latest PowerShell Gallery version, for {module name: Gallery package}.

    A module whose lookup fails keeps its last committed version (with a warning), as
    source_version does for the source's own version, so an outage never blanks them.
    """
    print(f"Fetching module versions from the PowerShell Gallery ({len(packages)} modules)...")
    with ThreadPoolExecutor(max_workers=10) as executor:
        found = dict(zip(packages, executor.map(gallery_latest_version, packages.values())))
    missing = [m for m, v in found.items() if not v]
    print(f"  Resolved {len(found) - len(missing)}/{len(found)} module versions")
    if missing:
        previous = previous_module_versions(source_id)
        print(f"::warning::{source_id}: {len(missing)} module versions unavailable; keeping the previous ones")
        for m in missing:
            found[m] = previous.get(m)
    return found


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


# Emphasis markup around a run of text: *a*, **a**, _a_, __a__ and `code`. A '_' or '*' inside a
# word, between spaces or escaped ("Standard_AzureFrontDoor", "2 * 3", "Standard\_Azure") is text.
EMPHASIS_RE = re.compile(r"(?<![\w*\\])(\*{1,2}|_{1,2})(?=\S)(.+?)(?<=[^\s\\])\1(?![\w*])|`([^`]+)`")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
ESCAPE_RE = re.compile(r"\\([\\`*_\[\]])")


def clean_synopsis(line):
    """A SYNOPSIS line as plain text: links become their text, emphasis loses its markup and
    markdown escapes ("Standard\\_AzureFrontDoor") their backslash."""
    line = LINK_RE.sub(r"\1", line)
    line = EMPHASIS_RE.sub(lambda m: m.group(2) if m.group(3) is None else m.group(3), line)
    return ESCAPE_RE.sub(r"\1", line).strip()


FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})\s*([^\s`]*)")


def fenced_blocks(section):
    """(language, code) for each fenced code block of a markdown section, in order.

    Fences are read line by line, so a closing fence is never taken for an opening one, and a
    block ends only at a fence of its own character at least as long as the one that opened it.
    The language is the info string, lower-cased ('' for an unlabelled block). A block still
    open when the section ends runs to its end, as CommonMark runs it to the end of its container.
    """
    fence = lang = None
    body = []
    for line in section.splitlines():
        if fence is None:
            m = FENCE_RE.match(line)
            if m:
                fence, lang, body = m.group(1), m.group(2).lower(), []
            continue
        if line.strip().startswith(fence) and not line.strip().strip(fence[0]):
            yield lang, "\n".join(body)
            fence = None
            continue
        body.append(line)
    if fence is not None:
        yield lang, "\n".join(body)


def syntax_from(section):
    """Every parameter set in a SYNTAX section: the docs give one fenced code block per set.

    The sets are joined by a blank line; the site splits them again at each line starting with
    the cmdlet name. Comment lines ("# ParameterSetName") are dropped.
    """
    sets = ["\n".join(l for l in code.splitlines() if not l.lstrip().startswith("#")).strip() for _, code in fenced_blocks(section)]
    return "\n\n".join(s for s in sets if s)


# Info strings the docs use for PowerShell; an unlabelled block is code too. "Output", "json",
# "yaml" and other blocks are skipped.
POWERSHELL_LANGS = {"", "powershell", "pwsh", "ps", "ps1", "posh"}
# A console prompt ("PS>", "PS C:\>", "PS /home/user>") is not part of the command to copy.
PROMPT_RE = re.compile(r"^PS(?:[ \t][^>\n]*)?>[ \t]*", re.MULTILINE)
# How many examples a cmdlet keeps; the detail pane shows them all.
MAX_EXAMPLES = 3


def examples_from(section, limit=MAX_EXAMPLES):
    """The PowerShell code blocks of an EXAMPLES section, at most `limit` of them (None: all).

    The code is kept as written, comments and <# #> blocks included, without its prompt.
    """
    examples = []
    for lang, code in fenced_blocks(section):
        code = PROMPT_RE.sub("", code).strip()
        if lang in POWERSHELL_LANGS and code:
            examples.append(code)
            if len(examples) == limit:
                break
    return examples


def require_cmdlets(source_id, count):
    """A run that found no cmdlets (an upstream folder renamed or emptied) fails rather than publish an empty source."""
    if not count:
        raise SystemExit(f"::error::{source_id}: no cmdlets found in the docs; refusing to write an empty source")
