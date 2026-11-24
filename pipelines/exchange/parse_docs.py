#!/usr/bin/env python3
"""
parse_docs.py -- Parse office-docs-powershell to generate ExchIndex data files.

Usage:
    bash pipelines/refresh.sh exchange   (writes data/exchange/ via $PSINDEX_OUT)

Output:
    $PSINDEX_OUT/manifest.json
    $PSINDEX_OUT/descriptions.json
    $PSINDEX_OUT/modules/{Module}.json
"""

import re
import json
import sys
from pathlib import Path

from common import examples_from, gallery_module_versions, output_dir, require_cmdlets, source_version, synopsis_from, syntax_from

# -- Workload directories relative to the repo root -------------------------
WORKLOAD_DIRS = [
    ('exchange/exchange-ps/ExchangePowerShell', 'Exchange'),
    ('teams/teams-ps/MicrosoftTeams', 'Teams'),
    ('skype/skype-ps/SkypeForBusiness', 'Skype for Business'),
    ('whiteboard/whiteboard-ps/WhiteboardAdmin', 'Whiteboard'),
    ('officewebapps/officewebapps-ps/officewebapps', 'Office Web Apps'),
    ('spmt/spmt-ps/Microsoft.SharePoint.MigrationTool.PowerShell', 'SharePoint Migration'),
]

# -- Exchange noun-based sub-category mapping --------------------------------
# The first pattern that matches the noun wins, so Client Access precedes the generic Mailbox
# pattern its CASMailbox, OwaMailboxPolicy and ActiveSyncMailboxPolicy nouns also match.
EXCHANGE_CATEGORY_MAP = [
    (r'CASMailbox|OwaMailboxPolicy|ActiveSync', 'Client Access'),
    (r'Mailbox', 'Mailbox Management'),
    (r'TransportRule|TransportConfig', 'Transport Rules'),
    (r'DlpCompliance', 'Data Loss Prevention'),
    (r'RetentionPolicy|RetentionCompliance', 'Retention & Compliance'),
    (r'AntiPhish|AntiSpam|MalwareFilter|SafeAttachment|SafeLinks', 'Threat Protection'),
    (r'DistributionGroup|UnifiedGroup|DynamicDistributionGroup', 'Groups & Distribution'),
    (r'OrganizationConfig|AcceptedDomain|RemoteDomain|FederatedOrganization', 'Organization'),
    (r'MoveRequest|MigrationBatch|MigrationEndpoint|MigrationUser', 'Migration'),
    (r'eDiscovery|ComplianceSearch|ComplianceCase', 'eDiscovery'),
    (r'JournalRule|MessageTrace|MessageTracking', 'Message Tracking'),
    (r'RoleGroup|ManagementRole|RoleAssignment', 'Permissions & Roles'),
    (r'AddressBook|AddressList|EmailAddress|GlobalAddressList', 'Address Management'),
]

VERB_RE = re.compile(r'^([A-Z][a-z]+)-')
CMDLET_RE = re.compile(r'^[A-Z][a-z]+-[A-Z]\w+')

# -- PowerShell Gallery package names per module -----------------------------
# Only modules published on the Gallery. SkypeForBusiness (the retired SkypeOnlineConnector
# download), officewebapps and the SharePoint Migration Tool module (installed with SPMT)
# are not, so their module files record no version.
MODULE_PACKAGE_MAP = {
    'ExchangePowerShell': 'ExchangeOnlineManagement',
    'MicrosoftTeams': 'MicrosoftTeams',
    'WhiteboardAdmin': 'WhiteboardAdmin',
}

def get_exchange_category(cmdlet_name):
    """Map an Exchange cmdlet to a sub-category by its noun."""
    noun = cmdlet_name.split('-', 1)[1] if '-' in cmdlet_name else ''
    for pattern, cat in EXCHANGE_CATEGORY_MAP:
        if re.search(pattern, noun, re.IGNORECASE):
            return cat
    return 'Exchange General'


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


def parse_cmdlet_doc(filepath, workload_name, default_module):
    """
    Parse a single cmdlet markdown file.
    Returns dict with: name, module, category, description, syntax, examples
    or None if this is not a cmdlet file.
    """
    text = Path(filepath).read_text(encoding='utf-8', errors='replace')
    front = parse_front_matter(text)

    # Cmdlet name: prefer 'title' front-matter field, fall back to filename stem
    name = front.get('title') or Path(filepath).stem
    if not CMDLET_RE.match(name):
        return None

    # Module name from front matter, else the workload's module directory. It also names the
    # module file, so it stays a file-safe module name, never the workload's display name.
    module = front.get('Module Name', '') or default_module

    # Category: Exchange cmdlets get sub-categorized, others use workload name
    if workload_name == 'Exchange':
        category = get_exchange_category(name)
    else:
        category = workload_name

    synopsis_sec = extract_section(text, 'SYNOPSIS')
    description = synopsis_from(synopsis_sec)

    syntax_sec = extract_section(text, 'SYNTAX')
    syntax = syntax_from(syntax_sec)

    examples_sec = extract_section(text, 'EXAMPLES')
    examples = examples_from(examples_sec)

    return {
        'name': name,
        'module': module,
        'category': category,
        'description': description,
        'syntax': syntax,
        'examples': examples,
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_docs.py <office-docs-powershell-root>")
        sys.exit(1)

    docs_root = Path(sys.argv[1])
    out_dir = output_dir()
    modules_dir = out_dir / 'modules'
    modules_dir.mkdir(parents=True, exist_ok=True)

    module_versions = gallery_module_versions(MODULE_PACKAGE_MAP, 'exchange')
    primary_version = source_version(module_versions.get('ExchangePowerShell'), 'exchange')

    manifest_entries = []
    descriptions = {}
    modules_data = {}  # module_name -> {module, cmdlets: {}}

    for rel_path, workload_name in WORKLOAD_DIRS:
        workload_dir = docs_root / rel_path
        if not workload_dir.is_dir():
            # A renamed upstream folder would silently drop a whole product, too small for the shrink check.
            raise SystemExit(f"::error::exchange: {workload_dir} not found; the upstream layout changed or the clone failed")

        count = 0
        for md_file in sorted(workload_dir.glob('*.md')):
            result = parse_cmdlet_doc(md_file, workload_name, workload_dir.name)
            if not result:
                continue

            cname = result['name']
            vm = VERB_RE.match(cname)
            verb = vm.group(1) if vm else 'Other'
            module = result['module']

            manifest_entries.append({
                'n': cname,
                'v': verb,
                'm': module,
                'c': result['category'],
                'e': bool(result['examples']),
            })

            if result['description']:
                descriptions[cname] = result['description']

            if module not in modules_data:
                modules_data[module] = {
                    'module': module,
                    'version': module_versions.get(module, ''),
                    'cmdlets': {},
                }

            modules_data[module]['cmdlets'][cname] = {
                'syntax': result['syntax'],
                'examples': result['examples'],
            }
            count += 1

        print(f"  {workload_name}: {count} cmdlets from {workload_dir}")

    print(f"\nProcessed {len(manifest_entries)} cmdlets across {len(modules_data)} modules")
    require_cmdlets('exchange', len(manifest_entries))

    # Write manifest.json
    manifest = {'v': primary_version, 'd': manifest_entries}
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
