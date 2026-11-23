#!/usr/bin/env bash
# Fetch the upstream docs into a scratch directory and regenerate data/entra/.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git clone --depth 1 --filter=blob:none --sparse https://github.com/MicrosoftDocs/entra-powershell-docs.git "$work/docs"
git -C "$work/docs" sparse-checkout set docs/reference/v1.0 docs/reference/beta
PYTHONPATH=pipelines python3 pipelines/entra/parse_docs.py "$work/docs/docs/reference"
