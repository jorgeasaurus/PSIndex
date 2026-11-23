import generated from '../sources.generated.json';
import type { SourceId, SourceMeta } from './types';

/** The source list, bundled at build time into both the page and the worker (see scripts/build-index.mjs). */
export const SOURCES = generated.sources as SourceMeta[];
export const TOTAL = generated.total;
export const BUILD = generated.build;

const fmt = new Intl.NumberFormat('en-US');

/** The extra value a source flags as a caution, e.g. Graph's "beta" API. */
export const isWarnExtra = (s: SourceMeta, extra: string) => !!s.extraWarn && extra === s.extraWarn;

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
  /** Label of the source's extra facet ('' = none, including "all"). */
  extraLabel: string;
  sources: SourceMeta[];
  /** Module and extra facets only make sense within one source. */
  perSourceFacets: boolean;
}

export const ALL: Scope = {
  id: 'all',
  color: '#b9c3d6',
  placeholder: `Search ${fmt.format(TOTAL)} cmdlets`,
  inLabel: '',
  extraLabel: '',
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
    extraLabel: s.extraLabel,
    sources: [s],
    perSourceFacets: true,
  }]),
]);

export const isScope = (id: string) => SCOPES.has(id);
/** Unknown ids (stale links) fall back to every source. */
export const scopeOf = (id: SourceId): Scope => SCOPES.get(id) ?? ALL;

const META = new Map(SOURCES.map((s) => [s.id, s]));
/** Rows only come from the worker, which only knows SOURCES, so a row's source always resolves. */
export const sourceOf = (id: SourceId): SourceMeta => META.get(id)!;

/** Inline style that tints an element (and its descendants) with a scope's or source's hue. */
export const srcStyle = (id: SourceId) => ({ '--src': scopeOf(id).color });
