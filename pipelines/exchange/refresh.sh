#!/usr/bin/env bash
# Fetch the upstream docs into a scratch directory and regenerate data/exchange/.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git clone --depth 1 https://github.com/MicrosoftDocs/office-docs-powershell.git "$work/docs"
python3 pipelines/exchange/parse_docs.py "$work/docs"
