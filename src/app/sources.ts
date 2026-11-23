import generated from '../sources.generated.json';
import type { SourceId, SourceMeta } from './types';

/** The source list, bundled at build time into both the page and the worker (see scripts/build-index.mjs). */
export const SOURCES: SourceMeta[] = generated.sources;
export const TOTAL = generated.total;

const fmt = new Intl.NumberFormat('en-US');
const list = new Intl.ListFormat('en', { type: 'conjunction' });

/** "Graph, Az, Entra, Exchange, and MECM" — for copy that names every source. */
export const SOURCE_NAMES = list.format(SOURCES.map((s) => s.short));
export const SOURCE_LABELS = list.format(SOURCES.map((s) => s.label));

/**
 * URL of a build artifact (/idx/… shards, /data/… module files). Versioned by build, so a page,
 * its worker and every file they fetch always come from the same deploy.
 */
export const assetUrl = (path: string) => `/${path}?v=${generated.build}`;

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
  placeholder: `Search ${fmt.format(TOTAL)} cmdlets`,
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
    placeholder: `Search ${fmt.format(s.count)} ${s.short} cmdlets`,
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
