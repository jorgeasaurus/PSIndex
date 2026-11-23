#!/usr/bin/env bash
# Fetch the upstream docs into a scratch directory and regenerate data/mecm/.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git clone --depth 1 --filter=blob:none --sparse https://github.com/MicrosoftDocs/sccm-docs-powershell-ref.git "$work/docs"
git -C "$work/docs" sparse-checkout set sccm-ps/ConfigurationManager
PYTHONPATH=pipelines python3 pipelines/mecm/parse_docs.py "$work/docs"
