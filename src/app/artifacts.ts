// The layout of the build artifacts under /a/<build>/: the one place their paths are spelled.
// scripts/build-index.ts writes them; the worker and the client read them through sources.ts assetUrl,
// which URL-encodes each segment (these are file-system paths).
export const artifactPath = {
  /** Columnar search index of one source, loaded first. */
  shard: (source: string) => `idx/${source}.json`,
  /** Short descriptions aligned to the shard, loaded after the first results. */
  desc: (source: string) => `idx/${source}.desc.json`,
  /** One module file's cmdlets by name, fetched when an entry is opened. */
  module: (source: string, file: string) => `data/${source}/${file}.json`,
};
