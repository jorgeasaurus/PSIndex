#!/usr/bin/env python3
"""
parse_docs.py - Parse MECM/SCCM PowerShell documentation markdown files and
generate JSON data files for MecmIndex.

Usage: bash pipelines/refresh.sh mecm   (writes data/mecm/ via $PSINDEX_OUT)

docs_dir defaults to ./docs and should contain sccm-ps/ConfigurationManager/
"""

import json
import os
import re
import sys
from pathlib import Path

from common import output_dir, require_cmdlets, syntax_from

NOUN_CATEGORIES = [
    ('AppV', 'Application Management'),
    ('DeploymentType', 'Application Management'),
    ('Application', 'Application Management'),
    ('Package', 'Application Management'),
    ('Script', 'Application Management'),
    ('SoftwareUpdate', 'Software Updates'),
    ('SumRule', 'Software Updates'),
    ('UpdateList', 'Software Updates'),
    ('UpdatePoint', 'Software Updates'),
    ('DeviceCollection', 'Collections'),
    ('UserCollection', 'Collections'),
    ('Collection', 'Collections'),
    ('TaskSequence', 'OS Deployment'),
    ('BootImage', 'OS Deployment'),
    ('Driver', 'OS Deployment'),
    ('OSImage', 'OS Deployment'),
    ('OperatingSystem', 'OS Deployment'),
    ('DistributionPoint', 'Content Management'),
    ('ContentLibrary', 'Content Management'),
    ('Content', 'Content Management'),
    ('Distribution', 'Content Management'),
    ('ManagementPoint', 'Site Infrastructure'),
    ('FallbackStatusPoint', 'Site Infrastructure'),
    ('SiteSystem', 'Site Infrastructure'),
    ('SiteRole', 'Site Infrastructure'),
    ('SiteAddress', 'Site Infrastructure'),
    ('BoundaryGroup', 'Site Infrastructure'),
    ('Boundary', 'Site Infrastructure'),
    ('Migration', 'Site Infrastructure'),
    ('Site', 'Site Infrastructure'),
    ('ConfigurationItem', 'Compliance'),
    ('ConfigItem', 'Compliance'),
    ('Baseline', 'Compliance'),
    ('CompliancePolicy', 'Compliance'),
    ('ComplianceRule', 'Compliance'),
    ('Remediation', 'Compliance'),
    ('AntiMalware', 'Endpoint Protection'),
    ('MalwarePolicy', 'Endpoint Protection'),
    ('FirewallPolicy', 'Endpoint Protection'),
    ('EndpointProtection', 'Endpoint Protection'),
    ('Defender', 'Endpoint Protection'),
    ('SecurityRole', 'Security'),
    ('SecurityScope', 'Security'),
    ('AdministrativeUser', 'Security'),
    ('Administrator', 'Security'),
    ('Credential', 'Security'),
    ('ClientSetting', 'Client Management'),
    ('ClientStatus', 'Client Management'),
    ('Client', 'Client Management'),
    ('UserDeviceAffinity', 'User Management'),
    ('UserAffinity', 'User Management'),
    ('DeviceAffinity', 'User Management'),
    ('User', 'User Management'),
    ('ReportingServicePoint', 'Reporting'),
    ('Report', 'Reporting'),
    ('Alert', 'Monitoring'),
    ('StatusMessage', 'Monitoring'),
    ('CMG', 'Cloud Management'),
    ('CoManagement', 'Co-Management'),
    ('CloudManagement', 'Cloud Management'),
    ('AssetIntelligence', 'Asset Intelligence'),
    ('HardwareInventory', 'Inventory'),
    ('Inventory', 'Inventory'),
    ('Certificate', 'Certificates'),
    ('MDM', 'Mobile Management'),
    ('Device', 'Device Management'),
    ('Computer', 'Device Management'),
    ('Resource', 'Device Management'),
    ('Query', 'Device Management'),
    ('Deployment', 'Deployment'),
    ('Category', 'General'),
]

SITE_ROLE_PATTERNS = [
    (r'central administration site', 'CAS'),
    (r'primary site', 'Primary'),
    (r'secondary site', 'Secondary'),
    (r'sms provider', 'SMS Provider'),
]


def get_category(noun):
    """Map a cmdlet noun to a category."""
    for pattern, category in NOUN_CATEGORIES:
        if noun.lower().startswith(pattern.lower()) or pattern.lower() in noun.lower():
            return category
    return 'General'


def get_category_slug(category):
    """Convert a category name to a file-safe slug."""
    slug = re.sub(r'[^A-Za-z0-9]', '', category)
    return slug


def detect_site_role(text):
    """Detect site role mentions in description text."""
    text_lower = text.lower()
    roles = []
    for pattern, role in SITE_ROLE_PATTERNS:
        if re.search(pattern, text_lower):
            roles.append(role)
    if not roles:
        return ''
    # Return the most specific / first found
    for preferred in ('CAS', 'Primary', 'Secondary', 'SMS Provider'):
        if preferred in roles:
            return preferred
    return roles[0]


def parse_front_matter(content):
    """Parse YAML-style front matter between --- delimiters."""
    meta = {}
    if not content.startswith('---'):
        return meta, content
    end = content.find('\n---', 3)
    if end < 0:
        return meta, content
    fm_text = content[3:end].strip()
    body = content[end + 4:].lstrip('\n')
    for line in fm_text.splitlines():
        if ':' in line:
            k, _, v = line.partition(':')
            meta[k.strip()] = v.strip().strip('"\'')
    return meta, body


def parse_section(body, section_name):
    """Extract content of a markdown section (## SECTION_NAME)."""
    pattern = r'(?:^|\n)## ' + re.escape(section_name) + r'\s*\n(.*?)(?=\n## |\Z)'
    m = re.search(pattern, body, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return ''


def parse_examples(examples_section):
    """Extract code blocks from EXAMPLES section."""
    examples = []
    # Look for ### Example N blocks
    example_blocks = re.split(r'\n### ', examples_section)
    for block in example_blocks:
        # Find code fences
        code_matches = re.findall(r'```(?:powershell|ps)?\n(.*?)```', block, re.DOTALL | re.IGNORECASE)
        for code in code_matches:
            code = code.strip()
            if code:
                examples.append(code)
    return examples


def parse_parameters_section(params_section):
    """Parse PARAMETERS section extracting per-param info."""
    params = []
    # Split on ### -ParamName headings (handle leading ### - on first block too)
    normalized = re.sub(r'^### -', '', params_section.lstrip('\n'))
    param_blocks = re.split(r'\n### -', normalized)
    for block in param_blocks:
        if not block.strip():
            continue
        lines = block.splitlines()
        param_name = lines[0].strip().lstrip('#').lstrip('-').strip()
        if not param_name or param_name.lower() in {'commonparameters', 'commonparamters'}:
            continue

        desc_lines = []
        param_type = 'Object'
        required = False

        i = 1
        # Collect description text (before the yaml property block)
        while i < len(lines) and not lines[i].strip().startswith('```'):
            desc_lines.append(lines[i])
            i += 1

        # Look for yaml-like property block
        in_yaml = False
        for line in lines[i:]:
            stripped = line.strip()
            if stripped == '```yaml' or stripped == '```':
                in_yaml = not in_yaml
                continue
            if in_yaml:
                if re.match(r'^Type:\s*', stripped, re.IGNORECASE):
                    param_type = re.sub(r'^Type:\s*', '', stripped, flags=re.IGNORECASE).strip()
                elif re.match(r'^Required:\s*', stripped, re.IGNORECASE):
                    val = re.sub(r'^Required:\s*', '', stripped, flags=re.IGNORECASE).strip().lower()
                    required = val == 'true'

        description = ' '.join(l.strip() for l in desc_lines if l.strip()).strip()
        # Clean markdown
        description = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', description)
        description = re.sub(r'\*\*([^*]+)\*\*', r'\1', description)
        description = re.sub(r'`([^`]+)`', r'\1', description)

        if param_name:
            params.append({
                'name': param_name,
                'type': param_type,
                'required': required,
                'description': description or '',
            })
    return params


def parse_cmdlet_file(filepath):
    """Parse a single cmdlet markdown file and return structured data."""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except OSError:
        return None

    meta, body = parse_front_matter(content)

    name = meta.get('Module Name', '') or meta.get('online version', '')
    # Try to get cmdlet name from filename
    stem = Path(filepath).stem
    if re.match(r'^[A-Za-z]+-CM\w+', stem):
        name = stem

    if not name or not re.match(r'^[A-Za-z]+-CM', name):
        return None

    verb = name.split('-')[0] if '-' in name else ''
    noun = name.split('-', 1)[1] if '-' in name else name
    # Strip CM prefix for categorization
    noun_stripped = noun[2:] if noun.upper().startswith('CM') else noun

    category = get_category(noun_stripped)

    synopsis = parse_section(body, 'SYNOPSIS').strip()
    # Clean up synopsis
    synopsis = re.sub(r'\n+', ' ', synopsis).strip()
    synopsis = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', synopsis)

    description_section = parse_section(body, 'DESCRIPTION')
    description_text = re.sub(r'\n+', ' ', description_section).strip()
    description_text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', description_text)

    site_role = detect_site_role(description_text + ' ' + synopsis)

    syntax_section = parse_section(body, 'SYNTAX')
    syntax = syntax_from(syntax_section)
    if not syntax:
        syntax = name

    examples_section = parse_section(body, 'EXAMPLES')
    examples = parse_examples(examples_section)

    params_section = parse_section(body, 'PARAMETERS')
    parameters = parse_parameters_section(params_section)

    has_examples = len(examples) > 0

    # Use synopsis as description, fall back to first sentence of description
    description = synopsis or description_text or f'Configuration Manager {noun_stripped} cmdlet.'

    return {
        'name': name,
        'verb': verb,
        'noun': noun,
        'category': category,
        'siteRole': site_role,
        'hasExamples': has_examples,
        'description': description,
        'syntax': syntax,
        'examples': examples,
        'parameters': parameters,
    }


def main():
    if len(sys.argv) < 2:
        sys.exit('Usage: parse_docs.py <sccm-docs clone root>  (run through pipelines/refresh.sh mecm)')
    out_dir = output_dir()  # checked before the (slow) parse, like every parser
    cmdlets_dir = os.path.join(sys.argv[1], 'sccm-ps', 'ConfigurationManager')
    if not os.path.isdir(cmdlets_dir):
        sys.exit(f'ERROR: {cmdlets_dir} not found')

    print(f'Scanning: {cmdlets_dir}')

    md_files = sorted(Path(cmdlets_dir).glob('*.md'))
    print(f'Found {len(md_files)} markdown files')

    all_cmdlets = []
    for filepath in md_files:
        result = parse_cmdlet_file(filepath)
        if result:
            all_cmdlets.append(result)

    print(f'Parsed {len(all_cmdlets)} cmdlets')

    require_cmdlets('mecm', len(all_cmdlets))

    # Group by category
    categories = {}
    for c in all_cmdlets:
        cat = c['category']
        if cat not in categories:
            categories[cat] = {}
        categories[cat][c['name']] = {
            'syntax': c['syntax'],
            'examples': c['examples'],
            'parameters': c['parameters'],
        }

    # Output directory
    modules_dir = out_dir / 'modules'
    modules_dir.mkdir(parents=True, exist_ok=True)

    # manifest.json
    manifest = {
        'v': '5.2311.1093.1',
        'd': [
            {
                'n': c['name'],
                'v': c['verb'],
                'c': c['category'],
                'r': c['siteRole'],
                'e': c['hasExamples'],
            }
            for c in sorted(all_cmdlets, key=lambda x: x['name'])
        ],
    }
    manifest_path = out_dir / 'manifest.json'
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, separators=(',', ':'))
    print(f'Written: {manifest_path} ({len(manifest["d"])} entries)')

    # descriptions.json
    descriptions = {c['name']: c['description'] for c in all_cmdlets if c['description']}
    desc_path = out_dir / 'descriptions.json'
    with open(desc_path, 'w', encoding='utf-8') as f:
        json.dump(descriptions, f, separators=(',', ':'))
    print(f'Written: {desc_path}')

    # Per-category module files
    for category, cmdlets_map in categories.items():
        slug = get_category_slug(category)
        module_data = {
            'module': slug,
            'cmdlets': cmdlets_map,
        }
        module_path = modules_dir / f'{slug}.json'
        with open(module_path, 'w', encoding='utf-8') as f:
            json.dump(module_data, f, separators=(',', ':'))
        print(f'Written: {module_path} ({len(cmdlets_map)} cmdlets)')

    print(f'\nDone! {len(all_cmdlets)} cmdlets across {len(categories)} categories.')


if __name__ == '__main__':
    main()
