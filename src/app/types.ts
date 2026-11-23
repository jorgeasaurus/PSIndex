export type SourceId = 'graph' | 'az' | 'entra' | 'exchange' | 'mecm' | 'errors';

export interface SourceMeta {
  id: SourceId;
  label: string;
  short: string;
  kind: 'cmdlet' | 'error';
  learn?: 'module' | 'configurationmanager';
  count: number;
  version: string;
}

/** Columnar index shard written by scripts/build-index.mjs. */
export interface IndexShard {
  n: string[]; // names (cmdlet name or error code)
  v: number[]; // verb id
  m: number[]; // module id (product for errors)
  c: number[]; // category id
  f: number[]; // detail file id
  x: number[]; // extra id: api version (graph/entra) or site role (mecm)
  p: number[]; // permission count (graph)
  e: number[]; // has examples / has resolution
  verbs: string[];
  mods: string[];
  cats: string[];
  files: string[];
  extras: string[];
}

export interface Filters {
  source: SourceId | 'all';
  verb: string;
  module: string;
  category: string;
  extra: string;
  examples: boolean;
}

export interface Row {
  key: string; // `${source}:${name}`
  source: SourceId;
  name: string;
  verb: string;
  module: string;
  category: string;
  extra: string;
  file: string;
  perms: number;
  examples: boolean;
  desc: string;
}

export interface Facets {
  verbs: string[];
  modules: string[];
  categories: string[];
  extras: string[];
}

// Worker protocol
export type ToWorker =
  | { type: 'search'; id: number; q: string; filters: Filters }
  | { type: 'rows'; id: number; refs: number[] }
  | { type: 'related'; id: number; key: string }
  | { type: 'find'; id: number; key: string };

export type FromWorker =
  | { type: 'ready'; sources: SourceId[] }
  | { type: 'desc-ready' }
  | { type: 'results'; id: number; refs: Int32Array; total: number; facets: Facets; ms: number }
  | { type: 'rows'; id: number; rows: Row[] }
  | { type: 'related'; id: number; rows: Row[] }
  | { type: 'found'; id: number; row: Row | null };
