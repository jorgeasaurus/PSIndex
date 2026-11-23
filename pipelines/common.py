"""Helpers shared by the pipelines. Import with the pipelines/ directory on sys.path."""
import json
from pathlib import Path


def keep_previous_versions(versions, modules, data_dir):
    """Fill in modules whose PowerShell Gallery lookup failed.

    `versions` maps module name -> version ('' or None when the lookup failed) and is updated in
    place from the module files the last successful run wrote to `data_dir/modules/`.
    """
    kept = []
    for module in modules:
        if versions.get(module):
            continue
        try:
            previous = json.loads((Path(data_dir) / "modules" / f"{module}.json").read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            continue
        if previous:
            versions[module] = previous
            kept.append(module)
    if kept:
        print(f"  Gallery lookup failed for {', '.join(kept)}; kept previous versions")
