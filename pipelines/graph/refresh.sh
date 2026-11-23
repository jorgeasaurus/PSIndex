#!/usr/bin/env bash
# Fetch the upstream docs into a scratch directory and regenerate data/graph/.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git clone --depth 1 --filter=blob:none --sparse https://github.com/MicrosoftDocs/microsoftgraph-docs-powershell.git "$work/docs"
git -C "$work/docs" sparse-checkout set microsoftgraph/graph-powershell-1.0 microsoftgraph/graph-powershell-beta
PYTHONPATH=pipelines python3 pipelines/graph/parse_docs.py "$work/docs/microsoftgraph"
