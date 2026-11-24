#!/usr/bin/env python3
"""
parse_docs.py — Parse azure-docs-powershell to generate AzIndex data files.

Usage:
    bash pipelines/refresh.sh az   (writes data/az/ via $PSINDEX_OUT)

Output:
    $PSINDEX_OUT/manifest.json
    $PSINDEX_OUT/descriptions.json
    $PSINDEX_OUT/modules/Az.<Module>.json
"""

import re
import json
import sys
from pathlib import Path

from common import examples_from, gallery_dependencies, gallery_module_versions, output_dir, require_cmdlets, source_version, synopsis_from, syntax_from

# ── Category mapping ──────────────────────────────────────────────────────────
CATEGORY_MAP = [
    ("Accounts", "Authentication"),
    ("Compute", "Compute"),
    ("Network", "Networking"),
    ("Storage", "Storage"),
    ("Sql", "Database"),
    ("CosmosDb", "Database"),
    ("Redis", "Database"),
    ("Monitor", "Monitoring"),
    ("Advisor", "Governance"),
    ("Policy", "Governance"),
    ("Security", "Security"),
    ("KeyVault", "Security"),
    ("Identity", "Identity"),
    ("Aks", "Containers"),
    ("ContainerInstance", "Containers"),
    ("ContainerRegistry", "Containers"),
    ("App", "App Services"),
    ("Websites", "App Services"),
    ("Functions", "App Services"),
    ("Logic", "Integration"),
    ("ServiceBus", "Messaging"),
    ("EventHub", "Messaging"),
    ("EventGrid", "Messaging"),
    ("NotificationHubs", "Messaging"),
    ("ApiManagement", "API Management"),
    ("Resources", "Resources"),
    ("ResourceMover", "Resources"),
    ("Cdn", "Networking"),
    ("Dns", "Networking"),
    ("FrontDoor", "Networking"),
    ("TrafficManager", "Networking"),
    ("VirtualWan", "Networking"),
    ("PowerBIEmbedded", "Analytics"),
    ("StreamAnalytics", "Analytics"),
    ("MachineLearning", "AI & ML"),
    ("CognitiveServices", "AI & ML"),
    ("DataFactory", "Data"),
    ("DataLakeStore", "Data"),
    ("Synapse", "Data"),
    ("Databricks", "Data"),
    ("Batch", "Compute"),
    ("HDInsight", "Compute"),
    ("ServiceFabric", "Compute"),
    ("Automation", "Management"),
    ("Backup", "Management"),
    ("RecoveryServices", "Management"),
    ("OperationalInsights", "Monitoring"),
]

VERB_RE = re.compile(r'^([A-Z][a-z]+)-Az')


def get_category(module_name):
    """Map Az.ModuleSuffix to a category string."""
    suffix = module_name.removeprefix("Az.")
    for key, cat in CATEGORY_MAP:
        if suffix.lower() == key.lower():
            return cat
    # Partial match fallback
    for key, cat in CATEGORY_MAP:
        if key.lower() in suffix.lower():
            return cat
    return "Other"


def parse_front_matter(text):
    """Extract YAML front matter fields as a dict."""
    m = re.match(r'^---\s*\n(.*?\n)---', text, re.DOTALL)
    if not m:
        return {}
    block = m.group(1)
    result = {}
    for line in block.splitlines():
        kv = line.split(':', 1)
        if len(kv) == 2:
            result[kv[0].strip()] = kv[1].strip().strip('"\'')
    return result


def extract_section(text, section_name):
    """Extract content under a ## SECTION_NAME heading."""
    pattern = rf'## {re.escape(section_name)}\s*\n(.*?)(?=\n## |\Z)'
    m = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else ''


def parse_cmdlet_doc(filepath):
    """
    Parse a single cmdlet markdown file.
    Returns dict with: name, module, syntax, description, examples
    or None if this is a module-level index file.
    """
    text = Path(filepath).read_text(encoding='utf-8', errors='replace')
    front = parse_front_matter(text)

    # Skip module index files (Az.ModuleName.md)
    fname = Path(filepath).stem
    if re.match(r'^Az\.[A-Za-z]+$', fname):
        return None

    # Cmdlet name: prefer 'title' front-matter field, fall back to filename stem
    name = front.get('title') or fname
    if not re.match(r'^[A-Z][a-z]+-Az', name):
        return None

    # Module name: prefer 'Module Name' front-matter field, fall back to Az.* parent directory
    module = front.get('Module Name', '')
    parent = Path(filepath).parent.name
    if (not module) and parent.startswith('Az.'):
        module = parent
    if not module or not module.startswith('Az.'):
        return None

    synopsis_sec = extract_section(text, 'SYNOPSIS')
    description = synopsis_from(synopsis_sec)

    syntax_sec = extract_section(text, 'SYNTAX')
    syntax = syntax_from(syntax_sec)

    examples_sec = extract_section(text, 'EXAMPLES')
    examples = examples_from(examples_sec)

    return {
        'name': name,
        'module': module,
        'description': description,
        'syntax': syntax,
        'examples': examples,
    }


def find_latest_azps_dir(docs_root):
    """Find the highest-versioned azps-* subdirectory."""
    root = Path(docs_root)
    if not root.is_dir():
        raise SystemExit(f'::error::az: docs root {docs_root} is not a directory')
    candidates = [d for d in root.iterdir() if d.is_dir() and d.name.startswith('azps-')]
    if not candidates:
        # Look one level deeper
        for sub in root.iterdir():
            if sub.is_dir():
                candidates += [d for d in sub.iterdir() if d.is_dir() and d.name.startswith('azps-')]
    if not candidates:
        raise SystemExit(f'::error::az: no azps-* docs directory under {docs_root}; the upstream layout changed or the clone failed')

    def ver_key(d):
        parts = re.findall(r'\d+', d.name)
        return tuple(int(x) for x in parts)

    return max(candidates, key=ver_key)


def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_docs.py <azure-docs-powershell-root>")
        sys.exit(1)

    docs_root = sys.argv[1]
    out_dir = output_dir()
    modules_dir = out_dir / 'modules'
    modules_dir.mkdir(parents=True, exist_ok=True)

    print(f"Scanning {docs_root} ...")
    azps_dir = find_latest_azps_dir(docs_root)
    version_str = re.search(r'azps-(\d+\.\d+\.\d+)', azps_dir.name)
    version = source_version(version_str.group(1) if version_str else None, 'az')
    print(f"Found: {azps_dir.name}  (version {version})")

    manifest_entries = []
    descriptions = {}
    modules_data = {}  # module_name -> {version, cmdlets: {}}

    mod_dirs = sorted(d for d in azps_dir.iterdir() if d.is_dir() and d.name.startswith('Az.'))

    # Each Az.* module's version is the one the Az rollup release bundles (the docs' own
    # "Module Version" front matter is a 0.0.0 placeholder). Modules the rollup does not
    # bundle (previews such as Az.Alb) take their own latest Gallery version.
    module_version_map = gallery_dependencies('Az', version, 'az')
    unbundled = {d.name: d.name for d in mod_dirs if not module_version_map.get(d.name)}
    module_version_map |= gallery_module_versions(unbundled, 'az')

    for mod_dir in mod_dirs:
        module_name = mod_dir.name
        mod_version = module_version_map.get(module_name)
        category = get_category(module_name)
        module_cmdlets = {}

        for md_file in sorted(mod_dir.glob('*.md')):
            result = parse_cmdlet_doc(md_file)
            if not result:
                continue
            cname = result['name']
            vm = VERB_RE.match(cname)
            verb = vm.group(1) if vm else 'Other'

            manifest_entries.append({
                'n': cname,
                'v': verb,
                'm': module_name,
                'c': category,
                'e': bool(result['examples']),
            })
            if result['description']:
                descriptions[cname] = result['description']

            module_cmdlets[cname] = {
                'syntax': result['syntax'],
                'examples': result['examples'],
            }

        if module_cmdlets:
            modules_data[module_name] = {
                'module': module_name,
                'version': mod_version,
                'cmdlets': module_cmdlets,
            }

    print(f"Processed {len(manifest_entries)} cmdlets across {len(modules_data)} modules")
    require_cmdlets('az', len(manifest_entries))

    # Write manifest.json
    manifest = {'v': version, 'd': manifest_entries}
    with open(out_dir / 'manifest.json', 'w', encoding='utf-8') as f:
        json.dump(manifest, f, separators=(',', ':'))
    print(f"Wrote manifest.json ({len(manifest_entries)} entries)")

    # Write descriptions.json
    with open(out_dir / 'descriptions.json', 'w', encoding='utf-8') as f:
        json.dump(descriptions, f, indent=2, ensure_ascii=False)
    print(f"Wrote descriptions.json ({len(descriptions)} entries)")

    # Write per-module JSON files
    for mod_name, data in modules_data.items():
        out_file = modules_dir / f'{mod_name}.json'
        with open(out_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    print(f"Wrote {len(modules_data)} module JSON files to {modules_dir}")


if __name__ == '__main__':
    main()
