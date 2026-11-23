#!/usr/bin/env bash
# Fetch the upstream docs into a scratch directory and regenerate data/errors/. The scraper clones its own sources.
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
python3 pipelines/errors/scrape_errors.py --workdir "$work/errors"
