/** Source ids come from scripts/build-index.mjs (SOURCES); they are data, not a hand-kept union. */
export type SourceId = string;

export interface SourceMeta {
  id: SourceId;
  label: string;
  short: string;
  color: string;
  /** The shard's `x` facet for this source: its label and an optional value shown as a caution ("beta"). */
  extra: { label: string; warn?: string } | null;
  learn: string; // Microsoft Learn URL template with {module} / {name}, or '' for none
  sample: string; // example search shown on the intro panel
  count: number;
  version: string;
}

/** Columnar index shard written by scripts/build-index.mjs. */
export interface IndexShard {
  n: string[]; // cmdlet names
  v: number[]; // verb id
  m: number[]; // module id
  c: number[]; // category id
  f: number[]; // detail file id
  x: number[]; // extra id: api version (graph/entra) or site role (mecm)
  p: number[]; // permission count (graph)
  e: number[]; // has examples
  verbs: string[];
  mods: string[];
  cats: string[];
  files: string[];
  extras: string[];
}

/** Module files under public/data/<source>/, as written by the pipelines. */
export interface CmdletDetail {
  syntax?: string;
  examples?: string[];
  permissions?: string[];
  parameters?: { name: string; type: string; required: boolean; description?: string }[];
  description?: string;
}
export interface CmdletFile { module: string; cmdlets: Record<string, CmdletDetail> }

export interface Filters {
  source: SourceId | 'all';
  verb: string;
  module: string;
  category: string;
  extra: string;
  examples: boolean;
}

export interface Row {
  key: string; // `${source}:${name}`, or `${source}:${name}@${module}` when the name repeats in its source
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
  dup: boolean; // name repeats within its source; show the module to tell the rows apart
}

export interface Facets {
  verbs: string[];
  modules: string[];
  categories: string[];
  extras: string[];
}

export interface Results { refs: Int32Array; facets: Facets; ms: number }

/** Request/reply pairs answered by the worker. */
export interface Requests {
  rows: { args: { refs: number[] }; reply: Row[] };
  related: { args: { key: string }; reply: Row[] };
  find: { args: { key: string }; reply: Row | null };
}
export type RequestType = keyof Requests;

export type ToWorker =
  | { type: 'search'; id: number; q: string; filters: Filters }
  | { [K in RequestType]: { type: K; id: number; args: Requests[K]['args'] } }[RequestType];

export type FromWorker =
  | { type: 'ready' }
  | { type: 'load-error'; message: string }
  | { type: 'desc-ready' }
  | ({ type: 'results'; id: number } & Results)
  | { type: 'reply'; id: number; reply: Requests[RequestType]['reply'] };
