// The page's URL format: the search, its filters and the open entry. The only module that knows
// parameter names, so links written by the app (history, "Copy link") and read back agree.
import { ALL, parseScope } from './sources';
import type { Filters } from './types';

const QUERY = 'q';
const OPEN = 'c';

/** One filter's URL parameter: its name, and how its value is read and written (null = omitted). */
interface Codec<T> { param: string; read: (raw: string | null) => T; write: (v: T) => string | null }
const text = (param: string): Codec<string> => ({ param, read: (raw) => raw ?? '', write: (v) => v || null });

const CODECS: { [K in keyof Filters]: Codec<Filters[K]> } = {
  // Unknown or stale source ids mean every source.
  source: { param: 's', read: parseScope, write: (v) => (v === ALL.id ? null : v) },
  verb: text('verb'),
  module: text('module'),
  category: text('cat'),
  extra: text('ver'),
  examples: { param: 'ex', read: (raw) => raw === '1', write: (v) => (v ? '1' : null) },
};

/** Object.keys loses the key type; CODECS has exactly the keys of Filters, so this cast is exact. */
const FILTER_KEYS = Object.keys(CODECS) as (keyof Filters)[];

function filtersFrom(p: URLSearchParams): Filters {
  const read = <K extends keyof Filters>(k: K) => CODECS[k].read(p.get(CODECS[k].param));
  const source = read('source');
  // Module and extra (API, site role) are facets of one source: across every source they don't apply.
  const perSource = source !== ALL.id;
  return {
    source, verb: read('verb'), module: perSource ? read('module') : '',
    category: read('category'), extra: perSource ? read('extra') : '', examples: read('examples'),
  };
}

/** The filters of a URL that sets none: every source, nothing narrowed. */
export const EMPTY_FILTERS = filtersFrom(new URLSearchParams());

/** Filters narrowing the results within the chosen source (the source itself is shown by the tabs). */
export const activeFilters = (f: Filters) => FILTER_KEYS.filter((k) => k !== 'source' && f[k] !== EMPTY_FILTERS[k]).length;

export interface UrlState { q: string; filters: Filters; open: string }

export function readUrl(): UrlState {
  const p = new URLSearchParams(location.search);
  return { q: p.get(QUERY) ?? '', filters: filtersFrom(p), open: p.get(OPEN) ?? '' };
}

export function writeUrl({ q, filters, open }: UrlState) {
  const p = new URLSearchParams();
  if (q.trim()) p.set(QUERY, q); // a blank query is no query
  const write = <K extends keyof Filters>(k: K) => {
    const v = CODECS[k].write(filters[k]);
    if (v !== null) p.set(CODECS[k].param, v);
  };
  FILTER_KEYS.forEach(write);
  if (open) p.set(OPEN, open);
  const qs = p.toString();
  const url = location.pathname + (qs ? '?' + qs : '');
  if (url !== location.pathname + location.search) history.replaceState(null, '', url);
}

/** Absolute link that opens one entry. */
export function entryUrl(key: string) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set(OPEN, key);
  return u.toString();
}
