import generated from '../sources.generated.json';
import type { SourceId, SourceMeta } from './types';

/** The source list, bundled at build time into both the page and the worker (see scripts/build-index.ts). */
export const SOURCES: SourceMeta[] = generated.sources;
export const TOTAL = generated.total;

const fmt = new Intl.NumberFormat('en-US');
/** "40,931" — the one number format the site uses. */
export const formatCount = (n: number) => fmt.format(n);
const list = new Intl.ListFormat('en', { type: 'conjunction' });

/** "Graph, Az, Entra, Exchange, and MECM" — for copy that names every source. */
export const SOURCE_NAMES = list.format(SOURCES.map((s) => s.short));
export const SOURCE_LABELS = list.format(SOURCES.map((s) => s.label));

/**
 * URL of a build artifact (idx/… shards, data/… module files). The build id is in the path and is
 * a hash of the artifacts, so a page and its worker only ever read files from their own build.
 */
export const assetUrl = (path: string) => `/a/${generated.build}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** A request that takes longer than this has stalled: it fails instead of loading forever. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Fetch a build artifact as JSON (page or worker). Failures carry a message written for the
 * reader, by cause: no answer, an artifact this build no longer has (the page is from an older
 * deploy), a server error, or a damaged file.
 */
export async function fetchAsset<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(assetUrl(path), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new Error('The server didn’t answer. Check your connection.');
  }
  if (r.status === 404) throw new Error('This page is out of date: a newer version of PSIndex has been published. Reload the page.');
  if (!r.ok) throw new Error(`The server answered with an error (HTTP ${r.status}).`);
  try {
    return await r.json();
  } catch {
    throw new Error('The server sent a damaged file.');
  }
}

/** The extra value a source flags as a caution, e.g. Graph's "beta" API. */
export const isWarnExtra = (s: SourceMeta, extra: string) => !!extra && extra === s.extra?.warn;

/** Query tokens as both the worker and the highlighter split them. */
export const queryTokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * What the UI is searching: one source, or every source ("all"). Everything that differs
 * between the two is a property here, so callers never special-case "all".
 */
export interface Scope {
  id: SourceId;
  color: string;
  placeholder: string;
  /** " in Graph", or '' for every source. */
  inLabel: string;
  /** Label of the source's extra facet; null for sources without one and for "all". */
  extraLabel: string | null;
  sources: SourceMeta[];
  /** Module and extra facets only make sense within one source. */
  perSourceFacets: boolean;
}

export const ALL: Scope = {
  id: 'all',
  color: '#b9c3d6',
  placeholder: `Search ${formatCount(TOTAL)} cmdlets`,
  inLabel: '',
  extraLabel: null,
  sources: SOURCES,
  perSourceFacets: false,
};

const SCOPES = new Map<SourceId, Scope>([
  [ALL.id, ALL],
  ...SOURCES.map((s): [SourceId, Scope] => [s.id, {
    id: s.id,
    color: s.color,
    placeholder: `Search ${formatCount(s.count)} ${s.short} cmdlets`,
    inLabel: ` in ${s.short}`,
    extraLabel: s.extra?.label ?? null,
    sources: [s],
    perSourceFacets: true,
  }]),
]);

/** A scope id from outside (the URL): unknown or missing ids, e.g. stale links, mean every source. */
export const parseScope = (id: string | null): SourceId => (id && SCOPES.has(id) ? id : ALL.id);
/** Scope ids in app state are always valid (they come from parseScope, SOURCES or ALL). */
export const scopeOf = (id: SourceId): Scope => SCOPES.get(id)!;

const META = new Map(SOURCES.map((s) => [s.id, s]));
/** Rows only come from the worker, which only knows SOURCES, so a row's source always resolves. */
export const sourceOf = (id: SourceId): SourceMeta => META.get(id)!;

/** Inline style that tints an element (and its descendants) with a scope's or source's hue. */
export const srcStyle = (id: SourceId) => ({ '--src': scopeOf(id).color });
