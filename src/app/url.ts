// The page's URL format: the search, its filters and the open entry. The only module that knows
// parameter names, so links written by the app (history, "Copy link") and read back agree.
import { ALL, parseScope } from './sources';
import type { Filters } from './types';

export const EMPTY_FILTERS: Filters = { source: ALL.id, verb: '', module: '', category: '', extra: '', examples: false };

const QUERY = 'q';
const OPEN = 'c';
/** Each filter's URL parameter. */
const PARAMS: Record<keyof Filters, string> = { source: 's', verb: 'verb', module: 'module', category: 'cat', extra: 'ver', examples: 'ex' };
const FILTER_KEYS = Object.keys(PARAMS) as (keyof Filters)[];

export interface UrlState { q: string; filters: Filters; open: string }

export function readUrl(): UrlState {
  const p = new URLSearchParams(location.search);
  const filters = { ...EMPTY_FILTERS };
  for (const k of FILTER_KEYS) {
    const raw = p.get(PARAMS[k]);
    if (raw === null) continue;
    (filters as Record<keyof Filters, string | boolean>)[k] = typeof EMPTY_FILTERS[k] === 'boolean' ? raw === '1' : raw;
  }
  // Unknown or stale source ids mean every source.
  filters.source = parseScope(p.get(PARAMS.source));
  return { q: p.get(QUERY) ?? '', filters, open: p.get(OPEN) ?? '' };
}

export function writeUrl({ q, filters, open }: UrlState) {
  const p = new URLSearchParams();
  if (q) p.set(QUERY, q);
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (v !== EMPTY_FILTERS[k]) p.set(PARAMS[k], v === true ? '1' : String(v));
  }
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
