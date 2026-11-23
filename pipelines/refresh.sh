#!/usr/bin/env bash
# Usage: pipelines/refresh.sh <source>
# Clone <source>'s upstream docs (pipelines/<source>/source.env) into a temp directory and
# regenerate data/<source>/ with pipelines/<source>/parse_docs.py.
set -euo pipefail
id=${1:?usage: pipelines/refresh.sh <source>}
cd "$(dirname "$0")/.."
# shellcheck source=/dev/null
source "pipelines/$id/source.env"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
if [ ${#SPARSE[@]} -gt 0 ]; then
  git clone --depth 1 --filter=blob:none --sparse "$REPO" "$work/docs"
  git -C "$work/docs" sparse-checkout set "${SPARSE[@]}"
else
  git clone --depth 1 "$REPO" "$work/docs"
fi
PYTHONPATH=pipelines python3 "pipelines/$id/parse_docs.py" "$work/docs/$PARSE_DIR"
