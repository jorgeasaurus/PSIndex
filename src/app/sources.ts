import generated from '../sources.generated.json';
import type { Filters, SourceId, SourceKind, SourceMeta } from './types';

/** The source list, bundled at build time into both the page and the worker (see scripts/build-index.mjs). */
export const SOURCES = generated.sources as SourceMeta[];
export const TOTAL = generated.total;
export const BUILD = generated.build;

const byId = new Map(SOURCES.map((s) => [s.id, s]));
export const sourceMeta = (id: SourceId): SourceMeta | undefined => byId.get(id);

const ALL_COLOR = '#b9c3d6';
export const sourceColor = (id: Filters['source']) => byId.get(id)?.color ?? ALL_COLOR;

/** Inline style that tints an element (and its descendants) with a source's hue. */
export const srcStyle = (id: Filters['source']) => ({ '--src': sourceColor(id) });

/**
 * Behaviour that differs between cmdlet and error sources. "All" behaves like cmdlets:
 * its filter bar offers verbs and examples.
 */
export interface KindSpec {
  moduleLabel: string;
  flagLabel: string;
  hasVerbs: boolean;
  versionPrefix: string;
  placeholder: (s: SourceMeta) => string;
  /** Lower-cased search key for a name (error codes ignore a leading 0x or minus). */
  normalize: (s: string) => string;
  /** Related entries: other verbs of the same noun, or neighbouring codes of the same product. */
  related: 'noun' | 'neighbours';
  relatedTitle: (name: string) => string;
  /** The qualifier shown at the end of a result row. */
  rowTag: (r: { module: string; extra: string; dup: boolean }) => string;
}

const fmt = new Intl.NumberFormat('en-US');

export const KINDS: Record<SourceKind, KindSpec> = {
  cmdlet: {
    moduleLabel: 'Module',
    flagLabel: 'Has examples',
    hasVerbs: true,
    versionPrefix: 'v',
    placeholder: (s) => `Search ${fmt.format(s.count)} ${s.short} cmdlets`,
    normalize: (s) => s.toLowerCase(),
    related: 'noun',
    relatedTitle: (name) => `Same noun · ${name.slice(name.indexOf('-') + 1)}`,
    rowTag: (r) => (r.dup ? r.module : r.extra === 'beta' ? 'beta' : ''),
  },
  error: {
    moduleLabel: 'Product',
    flagLabel: 'Has resolution',
    hasVerbs: false,
    versionPrefix: 'updated ',
    placeholder: () => 'Search error codes or messages: AADSTS50126, 0x80240017…',
    normalize: (s) => s.toLowerCase().replace(/^0x/, '').replace(/^-/, ''),
    related: 'neighbours',
    relatedTitle: () => 'Nearby codes',
    rowTag: (r) => r.module,
  },
};

export const kindOf = (id: Filters['source']): KindSpec => KINDS[byId.get(id)?.kind ?? 'cmdlet'];
