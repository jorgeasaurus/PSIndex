#!/usr/bin/env bash
# Fetch the upstream docs into a scratch directory and regenerate data/az/.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git clone --depth 1 --filter=blob:none --sparse https://github.com/MicrosoftDocs/azure-docs-powershell.git "$work/docs"
git -C "$work/docs" sparse-checkout set --no-cone 'azps-*/Az.*'
python3 pipelines/az/parse_docs.py "$work/docs"
