#!/usr/bin/env bash
# Usage: pipelines/refresh.sh <source>
# Clone <source>'s upstream docs (pipelines/<source>/source.env) into a temp directory, run
# pipelines/<source>/parse_docs.py into a fresh output directory, and only if it succeeds
# replace data/<source>/ with that output — so upstream deletions are reflected and a failed
# run leaves the committed data untouched.
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
mkdir "$work/out"
PSINDEX_OUT="$work/out" PYTHONPATH=pipelines python3 "pipelines/$id/parse_docs.py" "$work/docs/$PARSE_DIR"
rm -rf "data/$id"
cp -r "$work/out" "data/$id"
