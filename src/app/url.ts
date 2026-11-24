// The page's URL format: the search, its filters and the open entry. The only module that knows
// parameter names, so links written by the app (history, "Copy link") and read back agree.
import { ALL, parseScope, scopeOf, searchText } from './sources';
import type { Facets, Filters } from './types';

const QUERY = 'q';
const OPEN = 'c';

/** One filter's URL parameter: its name, and how its value is read and written (null = omitted). */
interface Codec<T> { param: string; read: (raw: string | null) => T; write: (v: T) => string | null }
const text = (param: string): Codec<string> => ({ param, read: (raw) => raw?.trim() ?? '', write: (v) => v || null });

const CODECS: { [K in keyof Filters]: Codec<Filters[K]> } = {
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
  const scope = scopeOf(read('source'));
  // Module and extra (API, site role) are facets of one source: across every source they don't
  // apply, and extra not in a source that has none (?s=az&ver=beta).
  return {
    source: scope.id, verb: read('verb'), module: scope.perSourceFacets ? read('module') : '',
    category: read('category'), extra: scope.extraLabel ? read('extra') : '', examples: read('examples'),
  };
}

/** The filters of a URL that sets none: every source, nothing narrowed. */
export const EMPTY_FILTERS = filtersFrom(new URLSearchParams());

/** Filters narrowing the results within the chosen source (the source itself is shown by the tabs). */
export const activeFilters = (f: Filters) => FILTER_KEYS.filter((k) => k !== 'source' && f[k] !== EMPTY_FILTERS[k]).length;

export const sameFilters = (a: Filters, b: Filters) => FILTER_KEYS.every((k) => a[k] === b[k]);

export interface UrlState { q: string; filters: Filters; open: string }

export function readUrl(): UrlState {
  const p = new URLSearchParams(location.search);
  // Pasted links often carry stray spaces; a blank value is no value.
  return { q: (p.get(QUERY) ?? '').trim(), filters: filtersFrom(p), open: (p.get(OPEN) ?? '').trim() };
}

/** The page URL (path and query string) for a state. */
export function urlOf({ q, filters, open }: UrlState) {
  const p = new URLSearchParams();
  const text = searchText(q);
  if (text) p.set(QUERY, text);
  const write = <K extends keyof Filters>(k: K) => {
    const v = CODECS[k].write(filters[k]);
    if (v !== null) p.set(CODECS[k].param, v);
  };
  FILTER_KEYS.forEach(write);
  if (open) p.set(OPEN, open);
  const qs = p.toString();
  return location.pathname + (qs ? '?' + qs : '');
}

export function writeUrl(state: UrlState) {
  const url = urlOf(state);
  if (url !== location.pathname + location.search) history.replaceState(history.state, '', url); // keeps the entry's state (the narrow-screen dialog's)
}

/** Absolute link that opens one entry. */
export function entryUrl(key: string) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set(OPEN, key);
  return u.toString();
}
