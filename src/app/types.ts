/** Source ids come from scripts/build-index.ts (SOURCES); they are data, not a hand-kept union. */
export type SourceId = string;

export interface SourceMeta {
  id: SourceId;
  label: string;
  short: string;
  color: string;
  /** The shard's `x` facet for this source: its label and an optional value shown as a caution ("beta"). */
  extra: { label: string; warn?: string } | null;
  sample: string; // example search shown on the intro panel
  count: number;
  version: string;
}

/** Columnar index shard written by scripts/build-index.ts. */
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
  fileVersions: string[]; // aligned with files: that module's version, '' when unknown
  extras: string[];
}

/** A parameter as a pipeline documents it (MECM does; others are parsed from the syntax). */
export interface DocumentedParam {
  name: string;
  type: string;
  required: boolean;
  description: string; // '' when undocumented
}

/** A cmdlet's detail as scripts/build-index.ts writes it: every field present ('' / [] when the docs have none). */
export interface CmdletDetail {
  syntax: string;
  examples: string[];
  permissions: string[];
  parameters: DocumentedParam[];
  description: string;
}
/** A module file (artifactPath.module): its cmdlets by name. */
export type CmdletFile = Record<string, CmdletDetail>;

export interface Filters {
  source: SourceId; // a source id, or 'all'
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
  moduleVersion: string; // '' when unknown
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

/** One search's answer; `id` is the search's, so a re-run of the same search keeps it. */
export interface Results { id: number; q: string; refs: Int32Array; facets: Facets; ms: number }

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
  | { type: 'load-error'; message: string }
  | ({ type: 'results' } & Results)
  | { type: 'reply'; id: number; reply: Requests[RequestType]['reply'] };
